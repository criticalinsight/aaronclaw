-- 🧙🏾‍♂️ Semantic Ontology: De-complecting meaning from code.
-- Stores term expansions for higher semantic resolution in Knowledge Retrieval.

CREATE TABLE IF NOT EXISTS semantic_ontology (
    term TEXT PRIMARY KEY,
    expansions TEXT NOT NULL, -- JSON array of strings
    metadata TEXT, -- JSON object for provenance/weights
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seed initial expansions from hardcoded SEMANTIC_EXPANSIONS
INSERT OR IGNORE INTO semantic_ontology (term, expansions) VALUES 
('aarondb', '["memory", "facts", "session"]'),
('context', '["memory", "history", "recall"]'),
('d1', '["database", "facts", "storage"]'),
('facts', '["memory", "history", "replay"]'),
('history', '["prior", "recall", "vault"]'),
('knowledge', '["memory", "vault", "recall"]'),
('recall', '["retrieve", "remember", "search"]'),
('session', '["conversation", "history", "state"]'),
('vector', '["embedding", "vectorize", "semantic"]'),
('vectorize', '["vector", "embedding", "semantic"]'),
('vault', '["knowledge", "history", "recall"]');
