-- Historical coins and existing bags keep their recorded denomination.
ALTER TABLE artemi_coins ALTER COLUMN bag_tokens SET DEFAULT 300000;
