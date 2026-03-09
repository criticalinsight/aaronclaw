CREATE TABLE IF NOT EXISTS aarondb_facts (
  session_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  attribute TEXT NOT NULL,
  value_json TEXT NOT NULL,
  tx INTEGER NOT NULL,
  tx_index INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'assert',
  PRIMARY KEY (session_id, tx, tx_index)
);

CREATE INDEX IF NOT EXISTS idx_aarondb_facts_session_entity
  ON aarondb_facts (session_id, entity);

CREATE INDEX IF NOT EXISTS idx_aarondb_facts_session_attribute
  ON aarondb_facts (session_id, attribute);