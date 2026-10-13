-- Optional: run manually before deployment if the app role cannot CREATE TABLE.
CREATE TABLE IF NOT EXISTS slzb_snapshots (
  account_id TEXT NOT NULL,
  bucket BIGINT NOT NULL,
  observed_at BIGINT NOT NULL,
  equity NUMERIC(38, 12) NOT NULL,
  PRIMARY KEY (account_id, bucket)
);

CREATE TABLE IF NOT EXISTS slzb_trade_ledgers (
  account_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS slzb_cost_settings (
  account_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  data JSONB NOT NULL
);

-- AES-256-GCM encrypted managed accounts/users; owner remains environment-only.
CREATE TABLE IF NOT EXISTS linden_directory (
  id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  ciphertext TEXT NOT NULL
);

-- Per-account administrator-defined futures net transfers; APIs never move funds.
CREATE TABLE IF NOT EXISTS slzb_futures_settings (
  account_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  data JSONB NOT NULL
);
