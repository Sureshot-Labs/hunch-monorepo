ALTER TABLE polymarket_markets
  ADD COLUMN IF NOT EXISTS neg_risk_market_id text;

UPDATE polymarket_markets
SET neg_risk_market_id = raw->>'negRiskMarketID'
WHERE neg_risk_market_id IS NULL
  AND raw ? 'negRiskMarketID';
