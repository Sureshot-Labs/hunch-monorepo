/* no-transaction */

ALTER TABLE limitless_contract_fee_receivables
ADD COLUMN IF NOT EXISTS source_kind text,
ADD COLUMN IF NOT EXISTS source_key text;

UPDATE limitless_contract_fee_receivables
SET source_kind = 'receipt'
WHERE source_kind IS NULL;

UPDATE limitless_contract_fee_receivables
SET source_key = 'receipt:' || tx_hash || ':' || log_index::text
WHERE source_key IS NULL
  AND tx_hash IS NOT NULL
  AND log_index IS NOT NULL;

UPDATE limitless_contract_fee_receivables
SET source_key = 'legacy:' || id::text
WHERE source_key IS NULL;

ALTER TABLE limitless_contract_fee_receivables
ALTER COLUMN source_kind SET DEFAULT 'receipt';

ALTER TABLE limitless_contract_fee_receivables
ALTER COLUMN source_kind SET NOT NULL;

ALTER TABLE limitless_contract_fee_receivables
ALTER COLUMN source_key SET NOT NULL;

ALTER TABLE limitless_contract_fee_receivables
ALTER COLUMN tx_hash DROP NOT NULL;

ALTER TABLE limitless_contract_fee_receivables
ALTER COLUMN log_index DROP NOT NULL;

ALTER TABLE limitless_contract_fee_receivables
DROP CONSTRAINT IF EXISTS limitless_contract_fee_receivables_source_kind_check;

ALTER TABLE limitless_contract_fee_receivables
ADD CONSTRAINT limitless_contract_fee_receivables_source_kind_check
CHECK (source_kind IN ('receipt', 'status'));

ALTER TABLE limitless_contract_fee_receivables
DROP CONSTRAINT IF EXISTS limitless_contract_fee_receivables_source_identity_check;

ALTER TABLE limitless_contract_fee_receivables
ADD CONSTRAINT limitless_contract_fee_receivables_source_identity_check
CHECK (
  source_kind <> 'receipt'
  OR (tx_hash IS NOT NULL AND log_index IS NOT NULL)
);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_limitless_contract_fee_receivables_source
  ON limitless_contract_fee_receivables(venue, fee_program, source_key, token_id);
