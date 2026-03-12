-- Migration: Initial Schema
-- Path: migrations/0000_schema.sql

CREATE TABLE facts (
    agent_id TEXT NOT NULL,
    entity INTEGER NOT NULL,
    attribute TEXT NOT NULL,
    value TEXT NOT NULL, -- Serialized JSON of the Value variant
    tx INTEGER NOT NULL,
    tx_index INTEGER NOT NULL,
    valid_time INTEGER NOT NULL,
    operation INTEGER NOT NULL, -- 1 = Assert, 0 = Retract
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (agent_id, tx, tx_index)
);

CREATE INDEX idx_facts_agent_entity ON facts (agent_id, entity);
CREATE INDEX idx_facts_agent_attribute ON facts (agent_id, attribute);
