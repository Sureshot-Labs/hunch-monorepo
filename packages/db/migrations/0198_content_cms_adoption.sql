-- Canonical adoption of the quarantined content CMS schema.
--
-- This migration is intentionally the only content migration entrypoint. It
-- accepts a clean database, a checksum-verified prefix from the removed
-- content migrator, or an already-complete final schema. Unknown partial
-- states fail before any content DDL is changed.

do $content_adoption_preflight$
declare
  expected_names constant text[] := array[
    '0001_content_cms.sql',
    '0002_content_asset_library_index.sql',
    '0003_content_route_history.sql',
    '0004_content_production_invariants.sql',
    '0005_content_multilingual_search.sql',
    '0006_content_operational_guards.sql',
    '0007_content_foreign_key_indexes.sql'
  ];
  expected_checksums constant text[] := array[
    '0373e4c34a83e3bc3256ec106be68573bf034a7f5a0639b439313264c1d724dd',
    '6f66d64b22d05d295ec3dfb290d56d66e59c44fd7c2eda50d4ca452a91553276',
    'aa3e82723ad92fcc79f979f46fdeea04f1be71aa474f10ee8ad03e5761e5be2c',
    '242f41d306d3b0edb97ed02ad0c958d0f1168430fb7100d9ea620fc44fbb95a7',
    '3a8c58ddf38a86f64d350154c07b2acc3473f3a3341f3150462d3f346af58ca6',
    'b4853af29c95fed4d57c77162f98a8275b181218fb6a683d32951779c9811037',
    '21676e2f0e476404d3d59bf4e527b356c58d88f0126a1e72f7acaf55685dc380'
  ];
  migration_row record;
  prefix_length integer := 0;
  content_table_count integer;
  required_column_count integer;
  required_column_fingerprint text;
  required_constraint_count integer;
begin
  select count(*)::integer
  into content_table_count
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relkind = 'r'
    and relation.relname = any (array[
      'content_assets',
      'content_articles',
      'content_article_drafts',
      'content_article_versions',
      'content_routes',
      'content_asset_usages',
      'content_publication_jobs',
      'content_outbox',
      'content_storage_deletion_jobs',
      'content_audit_events'
    ]);

  if to_regclass('public.content_schema_migrations') is not null then
    for migration_row in
      execute 'select filename, checksum from public.content_schema_migrations order by filename'
    loop
      prefix_length := prefix_length + 1;
      if prefix_length > cardinality(expected_names)
        or migration_row.filename <> expected_names[prefix_length]
        or migration_row.checksum <> expected_checksums[prefix_length]
      then
        raise exception
          'unknown legacy content migration state at row %: % (%)',
          prefix_length,
          migration_row.filename,
          migration_row.checksum
          using errcode = '55000';
      end if;
    end loop;

    if prefix_length = 0 and content_table_count <> 0 then
      raise exception
        'empty legacy content ledger cannot adopt existing content tables'
        using errcode = '55000';
    end if;
  elsif content_table_count <> 0 then
    if content_table_count <> 10 then
      raise exception
        'unknown partial content schema without legacy ledger: found % of 10 tables',
        content_table_count
        using errcode = '55000';
    end if;

    select
      count(*)::integer,
      md5(string_agg(
        table_name || '.' || column_name,
        ',' order by table_name, column_name
      ))
    into required_column_count, required_column_fingerprint
    from information_schema.columns
    where table_schema = 'public'
      and table_name = any (array[
        'content_assets',
        'content_articles',
        'content_article_drafts',
        'content_article_versions',
        'content_routes',
        'content_asset_usages',
        'content_publication_jobs',
        'content_outbox',
        'content_storage_deletion_jobs',
        'content_audit_events'
      ]);
    if required_column_count <> 153
      or required_column_fingerprint <> '6b8685c661ccd24753a4852e8d5cbb33'
    then
      raise exception
        'unknown content schema without legacy ledger: column fingerprint mismatch (% columns, fingerprint %)',
        required_column_count,
        required_column_fingerprint
        using errcode = '55000';
    end if;

    select count(*)::integer
    into required_constraint_count
    from pg_constraint constraint_record
    join pg_namespace namespace
      on namespace.oid = constraint_record.connamespace
    where namespace.nspname = 'public'
      and constraint_record.conname = any (array[
        'uq_content_article_versions_id_article',
        'fk_content_articles_published_version_owner',
        'fk_content_articles_scheduled_version_owner',
        'fk_content_asset_usages_version_owner',
        'fk_content_publication_jobs_version_owner',
        'fk_content_outbox_version_owner',
        'content_outbox_version_id_fkey',
        'content_assets_payload_size_check',
        'content_assets_checksum_required_check',
        'content_assets_nonpublic_quarantine_check',
        'content_article_drafts_document_size_check',
        'content_article_drafts_plain_text_size_check',
        'content_article_versions_document_size_check',
        'content_article_versions_plain_text_size_check',
        'content_outbox_payload_size_check',
        'content_audit_metadata_size_check'
      ]);
    if required_constraint_count <> 16 then
      raise exception
        'unknown partial content schema without legacy ledger: required final constraints are missing'
        using errcode = '55000';
    end if;
  end if;
end;
$content_adoption_preflight$;

-- Recreate named constraints below so the same finalization path is safe for
-- every checksum-verified legacy prefix and for an already-final schema.
alter table if exists content_outbox
  drop constraint if exists fk_content_outbox_version_owner;
alter table if exists content_publication_jobs
  drop constraint if exists fk_content_publication_jobs_version_owner;
alter table if exists content_asset_usages
  drop constraint if exists fk_content_asset_usages_version_owner;
alter table if exists content_articles
  drop constraint if exists fk_content_articles_published_version_owner,
  drop constraint if exists fk_content_articles_scheduled_version_owner,
  drop constraint if exists fk_content_articles_published_version,
  drop constraint if exists fk_content_articles_scheduled_version;
alter table if exists content_article_versions
  drop constraint if exists uq_content_article_versions_id_article;
alter table if exists content_assets
  drop constraint if exists content_assets_payload_size_check,
  drop constraint if exists content_assets_checksum_required_check,
  drop constraint if exists content_assets_nonpublic_quarantine_check;
alter table if exists content_article_drafts
  drop constraint if exists content_article_drafts_document_size_check,
  drop constraint if exists content_article_drafts_plain_text_size_check;
alter table if exists content_article_versions
  drop constraint if exists content_article_versions_document_size_check,
  drop constraint if exists content_article_versions_plain_text_size_check;
alter table if exists content_outbox
  drop constraint if exists content_outbox_payload_size_check;
alter table if exists content_audit_events
  drop constraint if exists content_audit_metadata_size_check;

-- Adopted from verified legacy 0001_content_cms.sql.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION content_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS content_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'failed', 'deleted')),
  kind text NOT NULL
    CHECK (kind IN ('image', 'video', 'audio', 'file')),
  storage_key text NOT NULL UNIQUE,
  public_url text,
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  checksum_sha256 text
    CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[a-f0-9]{64}$'),
  default_alt text,
  default_caption text,
  credit_name text,
  credit_url text,
  focal_x numeric(5, 4) CHECK (focal_x IS NULL OR focal_x BETWEEN 0 AND 1),
  focal_y numeric(5, 4) CHECK (focal_y IS NULL OR focal_y BETWEEN 0 AND 1),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_by_admin_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  deleted_at timestamptz,
  CHECK (char_length(storage_key) BETWEEN 1 AND 1024),
  CHECK (char_length(original_filename) BETWEEN 1 AND 512),
  CHECK (char_length(mime_type) BETWEEN 1 AND 255),
  CHECK (
    status <> 'ready'
    OR (public_url IS NOT NULL AND byte_size IS NOT NULL AND ready_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_content_assets_status_created
  ON content_assets (status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_content_assets_kind_created
  ON content_assets (kind, created_at DESC, id DESC)
  WHERE status = 'ready';

CREATE TABLE IF NOT EXISTS content_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  editorial_status text NOT NULL DEFAULT 'draft'
    CHECK (editorial_status IN ('draft', 'in_review', 'approved')),
  published_version_id uuid,
  scheduled_version_id uuid,
  published_slug text,
  published_tag_slugs text[] NOT NULL DEFAULT '{}'::text[],
  published_featured boolean NOT NULL DEFAULT false,
  first_published_at timestamptz,
  published_at timestamptz,
  scheduled_for timestamptz,
  archived_at timestamptz,
  created_by_admin_id uuid,
  updated_by_admin_id uuid,
  published_by_admin_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (published_version_id IS NULL AND published_slug IS NULL AND published_at IS NULL)
    OR (published_version_id IS NOT NULL AND published_slug IS NOT NULL AND published_at IS NOT NULL)
  ),
  CHECK (
    (scheduled_version_id IS NULL AND scheduled_for IS NULL)
    OR (scheduled_version_id IS NOT NULL AND scheduled_for IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_content_articles_publication
  ON content_articles (published_at DESC, id DESC)
  WHERE published_version_id IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_content_articles_editorial_updated
  ON content_articles (editorial_status, updated_at DESC, id DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_content_articles_scheduled
  ON content_articles (scheduled_for, id)
  WHERE scheduled_version_id IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_content_articles_published_tags_gin
  ON content_articles USING gin (published_tag_slugs)
  WHERE published_version_id IS NOT NULL AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS content_article_drafts (
  article_id uuid PRIMARY KEY REFERENCES content_articles(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  slug text NOT NULL,
  title text NOT NULL,
  excerpt text NOT NULL DEFAULT '',
  document jsonb NOT NULL DEFAULT '{"schemaVersion":1,"blocks":[]}'::jsonb
    CHECK (jsonb_typeof(document) = 'object'),
  list_cover jsonb CHECK (list_cover IS NULL OR jsonb_typeof(list_cover) = 'object'),
  hero_image jsonb CHECK (hero_image IS NULL OR jsonb_typeof(hero_image) = 'object'),
  social_image jsonb CHECK (social_image IS NULL OR jsonb_typeof(social_image) = 'object'),
  seo jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(seo) = 'object'),
  author jsonb NOT NULL DEFAULT '{"name":"Hunch"}'::jsonb
    CHECK (jsonb_typeof(author) = 'object'),
  category jsonb CHECK (category IS NULL OR jsonb_typeof(category) = 'object'),
  tags jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(tags) = 'array'),
  tag_slugs text[] NOT NULL DEFAULT '{}'::text[],
  locale text NOT NULL DEFAULT 'en',
  featured boolean NOT NULL DEFAULT false,
  plain_text text NOT NULL DEFAULT '',
  word_count integer NOT NULL DEFAULT 0 CHECK (word_count >= 0),
  reading_time_minutes integer NOT NULL DEFAULT 0 CHECK (reading_time_minutes >= 0),
  toc jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(toc) = 'array'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  updated_by_admin_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_document tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(slug, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(excerpt, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(plain_text, '')), 'C')
  ) STORED,
  CHECK (slug = lower(slug)),
  CHECK (char_length(slug) BETWEEN 1 AND 160),
  CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CHECK (char_length(title) BETWEEN 1 AND 160),
  CHECK (char_length(excerpt) <= 500),
  CHECK (char_length(locale) BETWEEN 2 AND 35)
);

CREATE INDEX IF NOT EXISTS idx_content_article_drafts_updated
  ON content_article_drafts (updated_at DESC, article_id DESC);

CREATE INDEX IF NOT EXISTS idx_content_article_drafts_search_gin
  ON content_article_drafts USING gin (search_document);

CREATE INDEX IF NOT EXISTS idx_content_article_drafts_tags_gin
  ON content_article_drafts USING gin (tag_slugs);

CREATE TABLE IF NOT EXISTS content_article_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES content_articles(id) ON DELETE CASCADE,
  version_number integer NOT NULL CHECK (version_number > 0),
  source_draft_revision integer NOT NULL CHECK (source_draft_revision > 0),
  kind text NOT NULL CHECK (kind IN ('checkpoint', 'published', 'scheduled')),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  slug text NOT NULL,
  title text NOT NULL,
  excerpt text NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  list_cover jsonb CHECK (list_cover IS NULL OR jsonb_typeof(list_cover) = 'object'),
  hero_image jsonb CHECK (hero_image IS NULL OR jsonb_typeof(hero_image) = 'object'),
  social_image jsonb CHECK (social_image IS NULL OR jsonb_typeof(social_image) = 'object'),
  seo jsonb NOT NULL CHECK (jsonb_typeof(seo) = 'object'),
  author jsonb NOT NULL CHECK (jsonb_typeof(author) = 'object'),
  category jsonb CHECK (category IS NULL OR jsonb_typeof(category) = 'object'),
  tags jsonb NOT NULL CHECK (jsonb_typeof(tags) = 'array'),
  tag_slugs text[] NOT NULL,
  locale text NOT NULL,
  featured boolean NOT NULL,
  plain_text text NOT NULL,
  word_count integer NOT NULL CHECK (word_count >= 0),
  reading_time_minutes integer NOT NULL CHECK (reading_time_minutes >= 0),
  toc jsonb NOT NULL CHECK (jsonb_typeof(toc) = 'array'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_by_admin_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (article_id, version_number),
  CHECK (slug = lower(slug)),
  CHECK (char_length(slug) BETWEEN 1 AND 160),
  CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

ALTER TABLE content_articles
  ADD CONSTRAINT fk_content_articles_published_version
  FOREIGN KEY (published_version_id)
  REFERENCES content_article_versions(id)
  ON DELETE SET NULL;

ALTER TABLE content_articles
  ADD CONSTRAINT fk_content_articles_scheduled_version
  FOREIGN KEY (scheduled_version_id)
  REFERENCES content_article_versions(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_content_article_versions_article_created
  ON content_article_versions (article_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_content_article_versions_article_revision
  ON content_article_versions (article_id, source_draft_revision DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_content_article_versions_tags_gin
  ON content_article_versions USING gin (tag_slugs);

CREATE TABLE IF NOT EXISTS content_routes (
  slug text PRIMARY KEY,
  article_id uuid NOT NULL REFERENCES content_articles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('reserved', 'current', 'redirect')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (slug = lower(slug)),
  CHECK (char_length(slug) BETWEEN 1 AND 160),
  CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_routes_current_article
  ON content_routes (article_id)
  WHERE kind = 'current';

CREATE INDEX IF NOT EXISTS idx_content_routes_article_kind
  ON content_routes (article_id, kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS content_asset_usages (
  id bigserial PRIMARY KEY,
  article_id uuid NOT NULL REFERENCES content_articles(id) ON DELETE CASCADE,
  version_id uuid REFERENCES content_article_versions(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES content_assets(id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (scope IN ('draft', 'version')),
  role text NOT NULL,
  block_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope = 'draft' AND version_id IS NULL)
    OR (scope = 'version' AND version_id IS NOT NULL)
  ),
  CHECK (char_length(role) BETWEEN 1 AND 64)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_asset_usages_draft_unique
  ON content_asset_usages (
    article_id,
    asset_id,
    role,
    coalesce(block_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE scope = 'draft';

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_asset_usages_version_unique
  ON content_asset_usages (
    version_id,
    asset_id,
    role,
    coalesce(block_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE scope = 'version';

CREATE INDEX IF NOT EXISTS idx_content_asset_usages_asset
  ON content_asset_usages (asset_id, scope, article_id);

CREATE TABLE IF NOT EXISTS content_publication_jobs (
  id bigserial PRIMARY KEY,
  article_id uuid NOT NULL REFERENCES content_articles(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES content_article_versions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'cancelled', 'failed')),
  run_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_publication_jobs_article_pending
  ON content_publication_jobs (article_id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_content_publication_jobs_due
  ON content_publication_jobs (run_at, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_content_publication_jobs_reclaim
  ON content_publication_jobs (locked_at, id)
  WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS content_outbox (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  article_id uuid NOT NULL REFERENCES content_articles(id) ON DELETE CASCADE,
  version_id uuid REFERENCES content_article_versions(id) ON DELETE SET NULL,
  dedupe_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(event_type) BETWEEN 1 AND 64),
  CHECK (char_length(dedupe_key) BETWEEN 1 AND 255)
);

CREATE INDEX IF NOT EXISTS idx_content_outbox_available
  ON content_outbox (available_at, id)
  WHERE processed_at IS NULL AND locked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_content_outbox_reclaim
  ON content_outbox (locked_at, id)
  WHERE processed_at IS NULL AND locked_at IS NOT NULL;

DROP TRIGGER IF EXISTS content_assets_set_updated_at ON content_assets;
CREATE TRIGGER content_assets_set_updated_at
  BEFORE UPDATE ON content_assets
  FOR EACH ROW EXECUTE FUNCTION content_set_updated_at();

DROP TRIGGER IF EXISTS content_articles_set_updated_at ON content_articles;
CREATE TRIGGER content_articles_set_updated_at
  BEFORE UPDATE ON content_articles
  FOR EACH ROW EXECUTE FUNCTION content_set_updated_at();

DROP TRIGGER IF EXISTS content_article_drafts_set_updated_at ON content_article_drafts;
CREATE TRIGGER content_article_drafts_set_updated_at
  BEFORE UPDATE ON content_article_drafts
  FOR EACH ROW EXECUTE FUNCTION content_set_updated_at();

DROP TRIGGER IF EXISTS content_routes_set_updated_at ON content_routes;
CREATE TRIGGER content_routes_set_updated_at
  BEFORE UPDATE ON content_routes
  FOR EACH ROW EXECUTE FUNCTION content_set_updated_at();

DROP TRIGGER IF EXISTS content_publication_jobs_set_updated_at ON content_publication_jobs;
CREATE TRIGGER content_publication_jobs_set_updated_at
  BEFORE UPDATE ON content_publication_jobs
  FOR EACH ROW EXECUTE FUNCTION content_set_updated_at();

DROP TRIGGER IF EXISTS content_outbox_set_updated_at ON content_outbox;
CREATE TRIGGER content_outbox_set_updated_at
  BEFORE UPDATE ON content_outbox
  FOR EACH ROW EXECUTE FUNCTION content_set_updated_at();

-- Adopted from verified legacy 0002_content_asset_library_index.sql.
CREATE INDEX IF NOT EXISTS idx_content_assets_created
  ON content_assets (created_at DESC, id DESC);

-- Adopted from verified legacy 0003_content_route_history.sql.
ALTER TABLE content_routes
  ADD COLUMN IF NOT EXISTS has_been_published boolean NOT NULL DEFAULT false;

UPDATE content_routes
SET has_been_published = true
WHERE kind IN ('current', 'redirect') AND has_been_published = false;

-- Adopted from verified legacy 0004_content_production_invariants.sql.
ALTER TABLE content_assets
  DROP CONSTRAINT IF EXISTS content_assets_status_check;

ALTER TABLE content_assets
  ADD CONSTRAINT content_assets_status_check
  CHECK (status IN ('pending', 'verifying', 'ready', 'failed', 'deleted'));

ALTER TABLE content_article_versions
  ADD CONSTRAINT uq_content_article_versions_id_article
  UNIQUE (id, article_id);

ALTER TABLE content_articles
  ADD CONSTRAINT fk_content_articles_published_version_owner
  FOREIGN KEY (published_version_id, id)
  REFERENCES content_article_versions(id, article_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE content_articles
  ADD CONSTRAINT fk_content_articles_scheduled_version_owner
  FOREIGN KEY (scheduled_version_id, id)
  REFERENCES content_article_versions(id, article_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE content_asset_usages
  ADD CONSTRAINT fk_content_asset_usages_version_owner
  FOREIGN KEY (version_id, article_id)
  REFERENCES content_article_versions(id, article_id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE content_publication_jobs
  ADD CONSTRAINT fk_content_publication_jobs_version_owner
  FOREIGN KEY (version_id, article_id)
  REFERENCES content_article_versions(id, article_id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE content_outbox
  ADD CONSTRAINT fk_content_outbox_version_owner
  FOREIGN KEY (version_id, article_id)
  REFERENCES content_article_versions(id, article_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION content_reject_version_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'content article versions are immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS content_article_versions_immutable
  ON content_article_versions;
CREATE TRIGGER content_article_versions_immutable
  BEFORE UPDATE ON content_article_versions
  FOR EACH ROW EXECUTE FUNCTION content_reject_version_update();

ALTER TABLE content_outbox
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;

DROP INDEX IF EXISTS idx_content_outbox_available;
CREATE INDEX idx_content_outbox_available
  ON content_outbox (available_at, id)
  WHERE processed_at IS NULL
    AND dead_lettered_at IS NULL
    AND locked_at IS NULL;

DROP INDEX IF EXISTS idx_content_outbox_reclaim;
CREATE INDEX idx_content_outbox_reclaim
  ON content_outbox (locked_at, id)
  WHERE processed_at IS NULL
    AND dead_lettered_at IS NULL
    AND locked_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS content_storage_deletion_jobs (
  id bigserial PRIMARY KEY,
  storage_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (char_length(storage_key) BETWEEN 1 AND 1024)
);

CREATE INDEX IF NOT EXISTS idx_content_storage_deletion_available
  ON content_storage_deletion_jobs (available_at, id)
  WHERE status = 'pending' AND locked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_content_storage_deletion_reclaim
  ON content_storage_deletion_jobs (locked_at, id)
  WHERE status = 'processing';

DROP TRIGGER IF EXISTS content_storage_deletion_jobs_set_updated_at
  ON content_storage_deletion_jobs;
CREATE TRIGGER content_storage_deletion_jobs_set_updated_at
  BEFORE UPDATE ON content_storage_deletion_jobs
  FOR EACH ROW EXECUTE FUNCTION content_set_updated_at();

CREATE TABLE IF NOT EXISTS content_audit_events (
  id bigserial PRIMARY KEY,
  action text NOT NULL,
  -- Audit identifiers intentionally are not foreign keys: audit history must
  -- survive data deletion and must never prevent an article/asset deletion.
  article_id uuid,
  asset_id uuid,
  version_id uuid,
  actor_admin_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(action) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS idx_content_audit_article_created
  ON content_audit_events (article_id, created_at DESC, id DESC)
  WHERE article_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_content_audit_asset_created
  ON content_audit_events (asset_id, created_at DESC, id DESC)
  WHERE asset_id IS NOT NULL;

-- Adopted from verified legacy 0005_content_multilingual_search.sql.
DROP INDEX IF EXISTS idx_content_article_drafts_search_gin;

ALTER TABLE content_article_drafts
  DROP COLUMN search_document;

ALTER TABLE content_article_drafts
  ADD COLUMN search_document tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(slug, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(excerpt, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(plain_text, '')), 'C')
  ) STORED;

CREATE INDEX idx_content_article_drafts_search_gin
  ON content_article_drafts USING gin (search_document);

-- Adopted from verified legacy 0006_content_operational_guards.sql.
ALTER TABLE content_assets
  ADD CONSTRAINT content_assets_payload_size_check
  CHECK (pg_column_size(metadata) <= 16384),
  ADD CONSTRAINT content_assets_checksum_required_check
  CHECK (checksum_sha256 IS NOT NULL),
  ADD CONSTRAINT content_assets_nonpublic_quarantine_check
  CHECK (
    status IN ('ready', 'deleted')
    OR (public_url IS NULL AND ready_at IS NULL)
  );

ALTER TABLE content_article_drafts
  ADD CONSTRAINT content_article_drafts_document_size_check
  CHECK (pg_column_size(document) <= 1000000),
  ADD CONSTRAINT content_article_drafts_plain_text_size_check
  CHECK (octet_length(plain_text) <= 2000000);

ALTER TABLE content_article_versions
  ADD CONSTRAINT content_article_versions_document_size_check
  CHECK (pg_column_size(document) <= 1000000),
  ADD CONSTRAINT content_article_versions_plain_text_size_check
  CHECK (octet_length(plain_text) <= 2000000);

ALTER TABLE content_outbox
  ADD CONSTRAINT content_outbox_payload_size_check
  CHECK (pg_column_size(payload) <= 65536);

ALTER TABLE content_audit_events
  ADD CONSTRAINT content_audit_metadata_size_check
  CHECK (pg_column_size(metadata) <= 16384);

CREATE INDEX IF NOT EXISTS idx_content_publication_jobs_failed
  ON content_publication_jobs (completed_at DESC, id DESC)
  WHERE status = 'failed';

CREATE INDEX IF NOT EXISTS idx_content_publication_jobs_retention
  ON content_publication_jobs (completed_at, id)
  WHERE status IN ('completed', 'cancelled', 'failed');

CREATE INDEX IF NOT EXISTS idx_content_article_versions_scheduled_retention
  ON content_article_versions (created_at, id)
  WHERE kind = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_content_outbox_dead_lettered
  ON content_outbox (dead_lettered_at, id)
  WHERE dead_lettered_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_content_outbox_retention
  ON content_outbox (processed_at, id)
  WHERE processed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_content_storage_deletion_failed
  ON content_storage_deletion_jobs (completed_at DESC, id DESC)
  WHERE status = 'failed';

CREATE INDEX IF NOT EXISTS idx_content_storage_deletion_retention
  ON content_storage_deletion_jobs (completed_at, id)
  WHERE status IN ('completed', 'failed');

CREATE INDEX IF NOT EXISTS idx_content_assets_stale_uploads
  ON content_assets (updated_at, id)
  WHERE status IN ('pending', 'verifying');

CREATE INDEX IF NOT EXISTS idx_content_audit_retention
  ON content_audit_events (created_at, id);

-- Adopted from verified legacy 0007_content_foreign_key_indexes.sql.
-- PostgreSQL does not create indexes on referencing foreign-key columns.
-- These indexes keep cascades, SET NULL actions, ownership checks, and the
-- scheduled-version retention anti-joins bounded as the operational tables grow.

CREATE INDEX IF NOT EXISTS idx_content_articles_published_version_owner
  ON content_articles (published_version_id, id)
  WHERE published_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_content_articles_scheduled_version_owner
  ON content_articles (scheduled_version_id, id)
  WHERE scheduled_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_content_asset_usages_version_owner
  ON content_asset_usages (version_id, article_id)
  WHERE version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_content_publication_jobs_version_owner
  ON content_publication_jobs (version_id, article_id);

CREATE INDEX IF NOT EXISTS idx_content_outbox_article
  ON content_outbox (article_id);

CREATE INDEX IF NOT EXISTS idx_content_outbox_version_owner
  ON content_outbox (version_id, article_id)
  WHERE version_id IS NOT NULL;

do $content_adoption_postflight$
declare
  content_table_count integer;
  required_column_count integer;
  required_column_fingerprint text;
  required_constraint_count integer;
  invalid_index_count integer;
begin
  select count(*)::integer
  into content_table_count
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relkind = 'r'
    and relation.relname = any (array[
      'content_assets',
      'content_articles',
      'content_article_drafts',
      'content_article_versions',
      'content_routes',
      'content_asset_usages',
      'content_publication_jobs',
      'content_outbox',
      'content_storage_deletion_jobs',
      'content_audit_events'
    ]);
  if content_table_count <> 10 then
    raise exception 'content adoption produced % of 10 required tables', content_table_count;
  end if;

  select
    count(*)::integer,
    md5(string_agg(
      table_name || '.' || column_name,
      ',' order by table_name, column_name
    ))
  into required_column_count, required_column_fingerprint
  from information_schema.columns
  where table_schema = 'public'
    and table_name = any (array[
      'content_assets',
      'content_articles',
      'content_article_drafts',
      'content_article_versions',
      'content_routes',
      'content_asset_usages',
      'content_publication_jobs',
      'content_outbox',
      'content_storage_deletion_jobs',
      'content_audit_events'
    ]);
  if required_column_count <> 153
    or required_column_fingerprint <> '6b8685c661ccd24753a4852e8d5cbb33'
  then
    raise exception
      'content adoption produced an unexpected column fingerprint (% columns, fingerprint %)',
      required_column_count,
      required_column_fingerprint;
  end if;

  select count(*)::integer
  into required_constraint_count
  from pg_constraint constraint_record
  join pg_namespace namespace
    on namespace.oid = constraint_record.connamespace
  where namespace.nspname = 'public'
    and constraint_record.conname = any (array[
      'uq_content_article_versions_id_article',
      'fk_content_articles_published_version_owner',
      'fk_content_articles_scheduled_version_owner',
      'fk_content_asset_usages_version_owner',
      'fk_content_publication_jobs_version_owner',
      'fk_content_outbox_version_owner',
      'content_outbox_version_id_fkey',
      'content_assets_payload_size_check',
      'content_assets_checksum_required_check',
      'content_assets_nonpublic_quarantine_check',
      'content_article_drafts_document_size_check',
      'content_article_drafts_plain_text_size_check',
      'content_article_versions_document_size_check',
      'content_article_versions_plain_text_size_check',
      'content_outbox_payload_size_check',
      'content_audit_metadata_size_check'
    ]);
  if required_constraint_count <> 16 then
    raise exception
      'content adoption produced % of 16 required final constraints',
      required_constraint_count;
  end if;

  select count(*)::integer
  into invalid_index_count
  from pg_index index_record
  join pg_class index_relation on index_relation.oid = index_record.indexrelid
  join pg_namespace namespace on namespace.oid = index_relation.relnamespace
  where namespace.nspname = 'public'
    and index_relation.relname like 'idx_content_%'
    and not index_record.indisvalid;
  if invalid_index_count <> 0 then
    raise exception 'content adoption left % invalid indexes', invalid_index_count;
  end if;
end;
$content_adoption_postflight$;

drop table if exists public.content_schema_migrations;
