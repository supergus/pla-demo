CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  ip TEXT,
  status TEXT NOT NULL,           -- queued | complete | errored
  output TEXT,                    -- JSON
  error TEXT,
  est_usd REAL,
  actual_usd REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at);
