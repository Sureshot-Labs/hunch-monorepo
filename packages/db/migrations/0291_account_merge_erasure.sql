-- No user FKs: provenance must survive deletion and must also exist in backups.
CREATE TABLE account_merge_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_user_id uuid NOT NULL,
  target_user_id uuid NOT NULL,
  keep_source boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX account_merge_transfers_source ON account_merge_transfers(source_user_id,created_at DESC,id DESC) WHERE NOT keep_source;
CREATE TABLE account_erasure_aliases (
  transfer_id uuid PRIMARY KEY REFERENCES account_merge_transfers(id),
  owner_user_id uuid NOT NULL
);
CREATE INDEX account_erasure_aliases_owner ON account_erasure_aliases(owner_user_id,transfer_id);

-- One record per remote attempt. No FK/cascade or retention expiry: an API
-- crash cannot acknowledge whether an accepted remote write finished. Such
-- attempts remain periodic repair obligations, even after asset/job removal.
CREATE TABLE content_promotion_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL,
  storage_key text NOT NULL,
  next_check_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_promotion_intents_due ON content_promotion_intents(next_check_at,id);
