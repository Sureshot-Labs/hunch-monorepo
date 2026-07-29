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
  ON DELETE SET NULL (version_id)
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
