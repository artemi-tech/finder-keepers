ALTER TABLE artemi_attempts DROP CONSTRAINT IF EXISTS artemi_attempts_kind_check;
ALTER TABLE artemi_attempts ADD CONSTRAINT artemi_attempts_kind_check CHECK(kind IN ('launch','claim','setup'));
CREATE TABLE IF NOT EXISTS artemi_lookups(wallet text PRIMARY KEY, address text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
