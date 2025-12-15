-- Enable pgcrypto so gen_random_uuid() is available.
-- Many migrations use gen_random_uuid() for UUID defaults.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

