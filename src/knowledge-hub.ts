import { type D1Database } from "@cloudflare/workers-types";

export interface GlobalPattern {
  patternKey: string;
  category: string;
  problemStatement: string;
  proposedAction: string;
  expectedBenefit: string;
  successRate: number;
  contributionCount: number;
}

export class KnowledgeHub {
  private readonly databases: D1Database[];

  constructor(databaseOrDatabases: D1Database | D1Database[]) {
    this.databases = Array.isArray(databaseOrDatabases) ? databaseOrDatabases : [databaseOrDatabases];
  }

  async contributePattern(pattern: Omit<GlobalPattern, "successRate" | "contributionCount">): Promise<void> {
    // 🧙🏾‍♂️ Rich Hickey: Accumulate facts, don't mutate truth.
    // We persist to the primary database.
    const primaryDb = this.databases[0];
    if (!primaryDb) return;

    await primaryDb
      .prepare(
        `INSERT INTO global_patterns (patternKey, category, problemStatement, proposedAction, expectedBenefit)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(patternKey) DO UPDATE SET
         contributionCount = contributionCount + 1,
         updatedAt = CURRENT_TIMESTAMP`
      )
      .bind(
        pattern.patternKey,
        pattern.category,
        pattern.problemStatement,
        pattern.proposedAction,
        pattern.expectedBenefit
      )
      .run();
  }

  async queryKnowledge(category?: string): Promise<GlobalPattern[]> {
    const allResults: GlobalPattern[] = [];
    const seenPatterns = new Set<string>();

    const query = category 
      ? "SELECT * FROM global_patterns WHERE category = ? ORDER BY successRate DESC, contributionCount DESC LIMIT 10"
      : "SELECT * FROM global_patterns ORDER BY successRate DESC, contributionCount DESC LIMIT 10";
    
    const params = category ? [category] : [];

    const results = await Promise.all(
      this.databases.map(db => db.prepare(query).bind(...params).all<GlobalPattern>())
    );

    for (const result of results) {
      for (const pattern of result.results ?? []) {
        if (seenPatterns.has(pattern.patternKey)) {
          // Merge logic: take the one with higher contribution count or success rate
          // For simplicity, we just skip duplicates for now
          continue;
        }
        seenPatterns.add(pattern.patternKey);
        allResults.push(pattern);
      }
    }

    return allResults.sort((a, b) => b.successRate - a.successRate || b.contributionCount - a.contributionCount).slice(0, 10);
  }

  async recordSuccess(patternKey: string, successful: boolean): Promise<void> {
    const adjust = successful ? 0.1 : -0.1;
    // Success is recorded globally across all reachable databases
    await Promise.all(
      this.databases.map(db => 
        db.prepare(
          "UPDATE global_patterns SET successRate = MAX(0, MIN(1.0, successRate + ?)), updatedAt = CURRENT_TIMESTAMP WHERE patternKey = ?"
        )
        .bind(adjust, patternKey)
        .run()
      )
    );
  }
}
