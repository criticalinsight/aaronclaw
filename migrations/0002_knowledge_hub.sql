-- Knowledge Hub: Shared Memory Substrate for Fleet Intelligence
CREATE TABLE global_patterns (
    patternKey TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    problemStatement TEXT NOT NULL,
    proposedAction TEXT NOT NULL,
    expectedBenefit TEXT NOT NULL,
    successRate REAL DEFAULT 0.0,
    contributionCount INTEGER DEFAULT 1,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_global_patterns_category ON global_patterns(category);
