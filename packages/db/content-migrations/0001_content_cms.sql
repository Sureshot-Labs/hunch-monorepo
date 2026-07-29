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
