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
