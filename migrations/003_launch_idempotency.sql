CREATE UNIQUE INDEX IF NOT EXISTS artemi_one_pending_launch_per_wallet ON artemi_attempts(wallet,kind) WHERE kind IN ('launch','setup') AND status IN ('prepared','queued','submitted');
