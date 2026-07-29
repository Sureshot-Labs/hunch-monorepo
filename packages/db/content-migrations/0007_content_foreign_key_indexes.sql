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
