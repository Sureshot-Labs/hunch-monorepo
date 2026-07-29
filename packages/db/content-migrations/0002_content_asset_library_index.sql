CREATE INDEX IF NOT EXISTS idx_content_assets_created
  ON content_assets (created_at DESC, id DESC);
