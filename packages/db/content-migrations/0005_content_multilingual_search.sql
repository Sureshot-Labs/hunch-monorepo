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
