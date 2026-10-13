ALTER TABLE artemi_coins ADD COLUMN archived_at timestamptz;
ALTER TABLE artemi_coins ADD COLUMN bag_tokens numeric(30,0) NOT NULL DEFAULT 100000 CHECK(bag_tokens>0);
-- Preserve historical denominations; only newly registered coins use 500k.
ALTER TABLE artemi_coins ALTER COLUMN bag_tokens SET DEFAULT 500000;
ALTER TABLE artemi_attempts ADD COLUMN archived_at timestamptz;
