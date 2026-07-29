ALTER TABLE content_routes
  ADD COLUMN IF NOT EXISTS has_been_published boolean NOT NULL DEFAULT false;

UPDATE content_routes
SET has_been_published = true
WHERE kind IN ('current', 'redirect') AND has_been_published = false;
