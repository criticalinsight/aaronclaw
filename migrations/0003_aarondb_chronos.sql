-- 🧙🏾‍♂️ Chronos: Temporal Integrity Migration
-- Adds occurred_at_dt as a native SQLite DATETIME for efficient temporal filtering.
-- Backfills from the existing occurred_at string facts.

ALTER TABLE aarondb_facts ADD COLUMN occurred_at_dt DATETIME DEFAULT CURRENT_TIMESTAMP;

-- Backfill: Standard Cloudflare ISO strings should parse correctly.
UPDATE aarondb_facts SET occurred_at_dt = occurred_at;

CREATE INDEX IF NOT EXISTS idx_aarondb_facts_temporal 
  ON aarondb_facts (session_id, occurred_at_dt);
