import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDocsContract, runScheduledDocsDriftReview } from "../src/docs-drift";
import worker, { SessionRuntime } from "../src/index";
import { queryKnowledgeVault } from "../src/knowledge-vault";
import {
  readPersistedModelSelection,
  setPersistedModelSelection
} from "../src/model-selection-store";
import { readProviderKeyStatus } from "../src/provider-key-store";
import {
  IMPROVEMENT_PROPOSAL_SESSION_ID,
  readImprovementProposalState,
  recordImprovementLifecycleAction,
  reflectSession,
  runScheduledImprovementProposalReview,
  runScheduledImprovementShadowEvaluation
} from "../src/reflection-engine";
import { AaronDbEdgeSessionRepository } from "../src/session-state";
import { buildTelegramSessionId } from "../src/telegram";

type FactRow = {
  session_id: string;
  entity: string;
  attribute: string;
  value_json: string;
  tx: number;
  tx_index: number;
  occurred_at: string;
  operation: "assert";
};

class FakePreparedStatement {
  constructor(
    private readonly database: FakeD1Database,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...params: unknown[]) {
    return new FakePreparedStatement(this.database, this.sql, params);
  }

  async all<T>() {
    return { results: this.database.query<T>(this.sql, this.params) };
  }

  async first<T>() {
    return (this.database.query<T>(this.sql, this.params)[0] as T) ?? null;
  }

  async run() {
    this.database.execute(this.sql, this.params);
    return { success: true };
  }
}

class FakeD1Database {
  private readonly rows: FactRow[] = [];

  prepare(sql: string) {
    return new FakePreparedStatement(this, sql);
  }

  async batch(statements: FakePreparedStatement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  query<T>(sql: string, params: unknown[]): T[] {
    if (sql.includes("FROM semantic_ontology")) {
       return [] as T[];
    }

    if (sql.includes("FROM global_patterns")) {
       return [] as T[]; // For now, just return empty list as if no historical patterns found
    }

    if (!sql.includes("FROM aarondb_facts")) {
      throw new Error(`Unsupported query: ${sql}`);
    }

    let parameterIndex = 0;
    let rows = [...this.rows];

    if (sql.includes("session_id != ?")) {
      const sessionId = String(params[parameterIndex++] ?? "");
      rows = rows.filter((row) => row.session_id !== sessionId);
    } else if (sql.includes("session_id = ?")) {
      const sessionId = String(params[parameterIndex++] ?? "");
      rows = rows.filter((row) => row.session_id === sessionId);
    }

    if (sql.includes("entity = ?")) {
      const entity = String(params[parameterIndex++] ?? "");
      rows = rows.filter((row) => row.entity === entity);
    }

    if (sql.includes("attribute = ?")) {
      const attribute = String(params[parameterIndex++] ?? "");
      rows = rows.filter((row) => row.attribute === attribute);
    }

    // Phase 6 improvement: Handle raw literals for common audit queries
    if (sql.includes("entity = 'tool_audit'") || sql.includes("entity = 'tool_event'")) {
       rows = rows.filter(row => row.entity === 'tool_audit' || row.entity === 'tool_event');
    }

    rows.sort((left, right) => {
      if (sql.includes("ORDER BY tx DESC") || sql.includes("occurred_at DESC")) {
        return right.tx - left.tx || right.tx_index - left.tx_index;
      }

      return left.tx - right.tx || left.tx_index - right.tx_index;
    });

    if (sql.includes("LIMIT")) {
      const match = sql.match(/LIMIT (\d+)/i);
      if (match) {
         rows = rows.slice(0, parseInt(match[1]));
      }
    }

    if (sql.trim().startsWith("SELECT session_id") || sql.includes("SELECT *")) {
      return rows as T[];
    }

    if (sql.includes("SELECT value_json")) {
      // Support returning both if requested (crude check)
      if (sql.includes("occurred_at")) {
         return rows.map((row) => ({ value_json: row.value_json, occurred_at: row.occurred_at } as T));
      }
      return rows.map((row) => ({ value_json: row.value_json } as T));
    }

    if (sql.includes("SELECT tx")) {
      return rows.map((row) => ({ tx: row.tx } as T));
    }

    return rows as T[];
  }

  execute(sql: string, params: unknown[]) {
    if (sql.includes("global_patterns")) {
       return; // Handle insertions/updates to global_patterns as no-op for now
    }

    if (!sql.includes("INSERT INTO aarondb_facts")) {
      throw new Error(`Unsupported statement: ${sql}`);
    }

    const [session_id, entity, attribute, value_json, tx, tx_index, occurred_at, operation] =
      params;

    this.rows.push({
      session_id: String(session_id),
      entity: String(entity),
      attribute: String(attribute),
      value_json: String(value_json),
      tx: Number(tx),
      tx_index: Number(tx_index),
      occurred_at: String(occurred_at),
      operation: operation as "assert"
    });
  }
}

class FakeDurableObjectState {
  readonly id: DurableObjectId;

  constructor(id: string) {
    this.id = { toString: () => id } as DurableObjectId;
  }

  waitUntil(_promise: Promise<unknown>) {}
}

class FakeSessionRuntimeNamespace {
  private readonly runtimes = new Map<string, SessionRuntime>();

  constructor(private readonly env: Env) {}

  idFromName(name: string) {
    return { toString: () => name } as DurableObjectId;
  }

  idFromString(id: string) {
    return { toString: () => id } as DurableObjectId;
  }

  newUniqueId() {
    return { toString: () => crypto.randomUUID() } as DurableObjectId;
  }

  getByName(name: string) {
    return this.get(this.idFromName(name));
  }

  jurisdiction() {
    return this;
  }

  get(id: DurableObjectId) {
    const name = id.toString();

    return {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const runtime = this.getRuntime(name);
        const request = input instanceof Request ? input : new Request(input, init);
        return runtime.fetch(request);
      }
    } as DurableObjectStub;
  }

  restart(name: string) {
    this.runtimes.delete(name);
  }

  private getRuntime(name: string) {
    const existing = this.runtimes.get(name);

    if (existing) {
      return existing;
    }

    const runtime = new SessionRuntime(
      new FakeDurableObjectState(name) as unknown as DurableObjectState,
      this.env
    );
    this.runtimes.set(name, runtime);
    return runtime;
  }
}

class FakeAiBinding {
  readonly runs: Array<{
    model: string;
    input: { messages: Array<{ role: string; content: string }> };
  }> = [];

  constructor(private readonly mode: "success" | "throw" | "empty" = "success") {}

  async run(model: string, input: any) {
    this.runs.push({ model, input });

    if (this.mode === "throw") {
      throw new Error("Workers AI unavailable");
    }

    if (this.mode === "empty") {
      return { response: "" };
    }

    if (input.text) {
      return { data: [new Array(model.includes("bge-small") ? 384 : 1024).fill(0.1)] };
    }

    const latestUserMessage = [...(input.messages || [])].reverse().find((message: any) => message.role === "user");

    return {
      response: `AI reply: ${latestUserMessage?.content ?? "(no prompt)"}`
    };
  }

  getLastRun() {
    return this.runs[this.runs.length - 1] ?? null;
  }
}

class FakeVectorizeIndex {
  private readonly vectors = new Map<
    string,
    {
      id: string;
      namespace?: string;
      values: number[];
      metadata?: Record<string, VectorizeVectorMetadata>;
    }
  >();

  constructor(private readonly mode: "success" | "throw" = "success") {}

  async query(vector: VectorFloatArray | number[], options?: VectorizeQueryOptions) {
    if (this.mode === "throw") {
      throw new Error("Vectorize unavailable");
    }

    const matches = [...this.vectors.values()]
      .filter((candidate) => !options?.namespace || candidate.namespace === options.namespace)
      .map((candidate) => ({
        id: candidate.id,
        namespace: candidate.namespace,
        metadata: candidate.metadata,
        score: cosineSimilarity(Array.from(vector), candidate.values)
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, options?.topK ?? 5);

    return { matches, count: matches.length } as VectorizeMatches;
  }

  async insert(vectors: VectorizeVector[]) {
    return this.upsert(vectors);
  }

  async upsert(vectors: VectorizeVector[]) {
    if (this.mode === "throw") {
      throw new Error("Vectorize unavailable");
    }

    for (const vector of vectors) {
      this.vectors.set(vector.id, {
        id: vector.id,
        namespace: vector.namespace,
        values: Array.from(vector.values),
        metadata: vector.metadata
      });
    }

    return {
      ids: vectors.map((vector) => vector.id),
      count: vectors.length
    } as VectorizeVectorMutation;
  }

  async deleteByIds(ids: string[]) {
    for (const id of ids) {
      this.vectors.delete(id);
    }

    return {
      ids,
      count: ids.length
    } as VectorizeVectorMutation;
  }

  async getByIds(ids: string[]) {
    return ids
      .map((id) => this.vectors.get(id))
      .filter((vector): vector is NonNullable<typeof vector> => Boolean(vector))
      .map((vector) => ({
        id: vector.id,
        namespace: vector.namespace,
        values: vector.values,
        metadata: vector.metadata
      }));
  }
}

function createEnv(options: {
  appAuthToken?: string;
  aiMode?: "success" | "throw" | "empty";
  geminiApiKey?: string;
  telegramBotToken?: string;
  telegramWebhookSecret?: string;
  vectorizeMode?: "success" | "throw";
} = {}) {
  const database = new FakeD1Database();
  const env = {
    AARONDB: database as unknown as D1Database,
    AI: options.aiMode ? new FakeAiBinding(options.aiMode) : (undefined as any),
    AI_MODEL: "@cf/meta/test-model",
    APP_AUTH_TOKEN: options.appAuthToken,
    GEMINI_API_KEY: options.geminiApiKey,
    TELEGRAM_BOT_TOKEN: options.telegramBotToken,
    TELEGRAM_WEBHOOK_SECRET: options.telegramWebhookSecret,
    VECTOR_INDEX: options.vectorizeMode
      ? (new FakeVectorizeIndex(options.vectorizeMode) as unknown as VectorizeIndex)
      : undefined,
    SESSION_RUNTIME: undefined as any
  } as Env & {
    SESSION_RUNTIME: DurableObjectNamespace & FakeSessionRuntimeNamespace;
  };

  env.SESSION_RUNTIME = new FakeSessionRuntimeNamespace(
    env as Env
  ) as unknown as DurableObjectNamespace & FakeSessionRuntimeNamespace;
  return { env, database };
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedHistoricalSession(database: FakeD1Database, sessionId: string, content: string) {
  const repository = new AaronDbEdgeSessionRepository(database as unknown as D1Database, sessionId);
  await repository.createSession("2026-03-09T00:00:00.000Z");
  await repository.appendMessage({
    timestamp: "2026-03-09T00:00:01.000Z",
    role: "user",
    content
  });
  await repository.appendToolEvent({
    timestamp: "2026-03-09T00:00:02.000Z",
    toolName: "search",
    summary: `Historical recall note: ${content}`
  });
}

async function seedCorrectionSession(
  database: FakeD1Database,
  input: {
    sessionId: string;
    prompt: string;
    assistant: string;
    correction: string;
  }
) {
  const repository = new AaronDbEdgeSessionRepository(
    database as unknown as D1Database,
    input.sessionId
  );
  await repository.createSession("2026-03-09T00:00:00.000Z");
  await repository.appendMessage({
    timestamp: "2026-03-09T00:00:01.000Z",
    role: "user",
    content: input.prompt
  });
  await repository.appendMessage({
    timestamp: "2026-03-09T00:00:02.000Z",
    role: "assistant",
    content: input.assistant
  });
  await repository.appendMessage({
    timestamp: "2026-03-09T00:00:03.000Z",
    role: "user",
    content: input.correction
  });
}

async function seedFallbackReflectionSession(
  database: FakeD1Database,
  env: Parameters<typeof reflectSession>[0]["env"],
  sessionId: string,
  fallbackReason: string,
  blockedToolId: string
) {
  const repository = new AaronDbEdgeSessionRepository(database as unknown as D1Database, sessionId);
  await repository.createSession("2026-03-09T00:00:00.000Z");
  await repository.appendMessage({
    timestamp: "2026-03-09T00:00:01.000Z",
    role: "user",
    content: "Why did the assistant take the degraded path?"
  });
  const session = await repository.appendMessage({
    timestamp: "2026-03-09T00:00:02.000Z",
    role: "assistant",
    content: "I had to fall back after a tool was blocked.",
    metadata: {
      fallbackReason,
      toolAuditTrail: [
        {
          toolId: blockedToolId,
          outcome: "blocked",
          detail: `${blockedToolId} was blocked while the assistant was gathering evidence.`
        }
      ]
    }
  });

  await reflectSession({ env, sessionId, session, timestamp: "2026-03-09T00:00:03.000Z" });
}

function cosineSimilarity(left: number[], right: number[]) {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

describe("AaronDbEdgeSessionRepository", () => {
  it("replays from the immutable fact log and recalls persisted memories", async () => {
    const database = new FakeD1Database();
    const repository = new AaronDbEdgeSessionRepository(
      database as unknown as D1Database,
      "session-1"
    );

    await repository.createSession("2026-03-09T00:00:00.000Z");
    await repository.appendMessage({
      timestamp: "2026-03-09T00:00:01.000Z",
      role: "user",
      content: "Remember that replay comes from the D1 fact log.",
      metadata: { topic: "replay" }
    });
    await repository.appendToolEvent({
      timestamp: "2026-03-09T00:00:02.000Z",
      toolName: "search",
      summary: "Inspected AaronDB edge architecture for session replay."
    });
    await repository.appendMessage({
      timestamp: "2026-03-09T00:00:03.000Z",
      role: "assistant",
      content: "Durable Objects rehydrate hot state from AaronDB facts."
    });

    const rehydrated = new AaronDbEdgeSessionRepository(
      database as unknown as D1Database,
      "session-1"
    );

    const replayed = await rehydrated.getSession();
    expect(replayed?.messages).toHaveLength(2);
    expect(replayed?.toolEvents).toHaveLength(1);
    expect(replayed?.lastTx).toBe(4);
    expect(replayed?.messages[0]?.metadata).toMatchObject({ topic: "replay" });

    const asOf = await rehydrated.getSession({ asOf: 2 });
    expect(asOf?.events).toHaveLength(1);

    const recall = await rehydrated.recall({ query: "How does D1 replay work?" });
    expect(recall[0]?.preview).toContain("D1 fact log");

    const recallAsOf = await rehydrated.recall({
      query: "D1 replay",
      asOf: 2
    });
    expect(recallAsOf).toHaveLength(1);
    expect(recallAsOf[0]?.tx).toBe(2);
    expect(recallAsOf[0]?.preview).toContain("D1 fact log");
  });
});

describe("knowledge vault", () => {
  it("returns Vectorize-backed matches from historical D1 fact logs when the binding exists", async () => {
    const { env, database } = createEnv({ vectorizeMode: "success" });

    await seedHistoricalSession(
      database,
      "history-1",
      "Vectorize-backed retrieval can recover prior AaronDB D1 fact context for later chats."
    );

    const result = await queryKnowledgeVault({
      env,
      sessionId: "live-session",
      query: "How does Vectorize recover D1 fact context?"
    });

    expect(result.source).toBe("vectorize");
    expect(result.matches[0]).toMatchObject({
      sessionId: "history-1",
      source: "vectorize"
    });
    expect(result.matches[0]?.preview).toContain("Vectorize-backed retrieval");
  });

  it("falls back to local D1 compatibility ranking when Vectorize is unavailable", async () => {
    const { env, database } = createEnv({ vectorizeMode: "throw" });

    await seedHistoricalSession(
      database,
      "history-2",
      "The knowledge vault can still rank D1 facts locally when the vector service is blocked."
    );

    const result = await queryKnowledgeVault({
      env,
      sessionId: "live-session",
      query: "Can the knowledge vault rank D1 facts locally?"
    });

    expect(result.source).toBe("d1-compat");
    expect(result.matches[0]).toMatchObject({
      sessionId: "history-2",
      source: "d1-compat"
    });
    expect(result.matches[0]?.preview).toContain("rank D1 facts locally");
  });

  it("falls back to local D1 compatibility ranking when the Vectorize binding is omitted", async () => {
    const { env, database } = createEnv();

    await seedHistoricalSession(
      database,
      "history-3",
      "The knowledge vault can still rank D1 facts locally when the deploy config omits Vectorize."
    );

    const result = await queryKnowledgeVault({
      env,
      sessionId: "live-session",
      query: "Can the knowledge vault still work without a Vectorize binding?"
    });

    expect(result.source).toBe("d1-compat");
    expect(result.matches[0]).toMatchObject({
      sessionId: "history-3",
      source: "d1-compat"
    });
    expect(result.matches[0]?.preview).toContain("deploy config omits Vectorize");
  });
});

describe("worker session routes", () => {
  it("creates, chats, and rehydrates persisted state through the Worker API", async () => {
    const { env } = createEnv({ aiMode: "success" });

    const created = await worker.fetch(
      new Request("https://aaronclaw.test/api/sessions", { method: "POST" }),
      env as Env
    );
    const createdBody = (await created.json()) as {
      sessionId: string;
      session: { id: string };
    };

    expect(created.status).toBe(201);
    expect(createdBody.session.id).toBe(createdBody.sessionId);

    const chatted = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Please remember the AaronDB replay path in D1."
        })
      }),
      env as Env
    );
    const chattedBody = (await chatted.json()) as {
      assistant: { content: string; source: string };
    };

    expect(chatted.status).toBe(201);
    expect(chattedBody.assistant.source).toBe("workers-ai");
    expect(chattedBody.assistant.content).toContain("AI reply");

    env.SESSION_RUNTIME.restart(createdBody.sessionId);

    const replayed = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}`),
      env as Env
    );
    const replayedBody = (await replayed.json()) as {
      session: {
        events: Array<{ kind: string; content?: string; role?: string }>;
        recallableMemoryCount: number;
      };
    };

    expect(replayed.status).toBe(200);
    expect(replayedBody.session.events).toHaveLength(2);
    expect(replayedBody.session.events[1]).toMatchObject({
      kind: "message",
      role: "assistant"
    });
    expect(replayedBody.session.recallableMemoryCount).toBeGreaterThan(0);

    const recalled = await worker.fetch(
      new Request(
        `https://aaronclaw.test/api/sessions/${createdBody.sessionId}/recall?q=${encodeURIComponent("D1 replay")}`
      ),
      env as Env
    );
    const recallBody = (await recalled.json()) as { matches: Array<{ preview: string }> };

    expect(recalled.status).toBe(200);
    expect(recallBody.matches[0]?.preview).toContain("AaronDB replay path");
  });

  it("warms persona-oriented semantic prefetch context before final chat generation", async () => {
    const { env } = createEnv({ aiMode: "success" });

    const created = await worker.fetch(
      new Request("https://aaronclaw.test/api/sessions", { method: "POST" }),
      env as Env
    );
    const createdBody = (await created.json()) as { sessionId: string };

    await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "user",
          content: "Remember that D1 facts let the session replay and rehydrate after restarts."
        })
      }),
      env as Env
    );

    await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/tool-events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolName: "search",
          summary: "Prefetched prior memory about persona context and replayable AaronDB state."
        })
      }),
      env as Env
    );

    const chatted = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "How does the assistant remember D1 replay state?"
        })
      }),
      env as Env
    );

    expect(chatted.status).toBe(201);

    const ai = env.AI as FakeAiBinding;
    const lastRun = ai.getLastRun();

    expect(lastRun?.model).toBe("@cf/meta/test-model");
    expect(lastRun?.input.messages[0]?.content).toContain(
      "AaronDB Persona runtime (compatibility layer)"
    );
    expect(lastRun?.input.messages[0]?.content).toContain("- type: persona");
    expect(lastRun?.input.messages[0]?.content).toContain(
      "- prefetchStrategy: aarondb-semantic-compat"
    );
    expect(lastRun?.input.messages[1]?.content).toContain(
      "Semantic prefetch warmed context before final response generation"
    );
    expect(lastRun?.input.messages[1]?.content).toContain("D1 facts");
  });

  it("adds Hyper-Recall knowledge-vault context to the live chat path without changing the API shape", async () => {
    const { env, database } = createEnv({ aiMode: "success", vectorizeMode: "success" });

    await seedHistoricalSession(
      database,
      "history-3",
      "A knowledge vault can use Vectorize to retrieve semantically relevant AaronDB history from D1 facts."
    );

    const created = await worker.fetch(
      new Request("https://aaronclaw.test/api/sessions", { method: "POST" }),
      env as Env
    );
    const createdBody = (await created.json()) as { sessionId: string };

    const chatted = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Can you recall prior Vectorize history from D1 facts?"
        })
      }),
      env as Env
    );

    expect(chatted.status).toBe(201);

    const ai = env.AI as FakeAiBinding;
    const lastRun = ai.getLastRun();

    expect(lastRun?.input.messages[0]?.content).toContain(
      "- hyperRecallStrategy: vectorize-knowledge-vault-compat"
    );
    expect(lastRun?.input.messages[1]?.content).toContain("[knowledge-vault");
    expect(lastRun?.input.messages[1]?.content).toContain("retrieve semantically relevant AaronDB history");
  });

  it("persists post-session reflection into a synthetic reflection session without changing the chat API shape", async () => {
    const { env } = createEnv({ aiMode: "success" });

    const created = await worker.fetch(
      new Request("https://aaronclaw.test/api/sessions", { method: "POST" }),
      env as Env
    );
    const createdBody = (await created.json()) as { sessionId: string };

    const chatted = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Please prove the recall path with evidence." })
      }),
      env as Env
    );
    const chattedBody = (await chatted.json()) as {
      assistant: { content: string };
      session: { events: unknown[] };
    };

    const reflectionRepository = new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      `reflection:${createdBody.sessionId}`
    );
    const reflectionSession = await reflectionRepository.getSession();

    expect(chatted.status).toBe(201);
    expect(chattedBody.session.events).toHaveLength(2);
    expect(reflectionSession?.toolEvents[0]).toMatchObject({
      toolName: "session-reflection"
    });
    expect(reflectionSession?.toolEvents[0]?.summary).toContain("Reflection for");
    expect(reflectionSession?.toolEvents[0]?.metadata).toMatchObject({
      improvementSignalCount: 1,
      improvementCandidateCount: 1,
      improvementSignals: [
        expect.objectContaining({
          signalKey: "evidence-intent-without-tool-trace",
          category: "verification",
          status: "active",
          risk: expect.objectContaining({ level: "high" }),
          verification: expect.objectContaining({ status: "pending" })
        })
      ],
      improvementCandidates: [
        expect.objectContaining({
          candidateKey: "add-tool-backed-verification-step",
          status: "proposed",
          derivedFromSignalKeys: ["evidence-intent-without-tool-trace"]
        })
      ]
    });
  });

  it("preserves the init, messages, and tool-events session API flow", async () => {
    const { env } = createEnv();

    const created = await worker.fetch(
      new Request("https://aaronclaw.test/api/sessions", { method: "POST" }),
      env as Env
    );
    const createdBody = (await created.json()) as {
      sessionId: string;
      session: { id: string; events: unknown[] };
    };

    const messageResponse = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "user",
          content: "Store this message through the mounted AaronDB seam."
        })
      }),
      env as Env
    );
    const messageBody = (await messageResponse.json()) as {
      session: { messages: Array<{ role: string; content: string }> };
    };

    const toolEventResponse = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/tool-events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolName: "search",
          summary: "Stored a tool event through the mounted AaronDB seam."
        })
      }),
      env as Env
    );
    const toolEventBody = (await toolEventResponse.json()) as {
      session: { toolEvents: Array<{ toolName: string; summary: string }> };
    };

    const stateResponse = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}`),
      env as Env
    );
    const stateBody = (await stateResponse.json()) as {
      session: {
        id: string;
        messages: Array<{ role: string; content: string }>;
        toolEvents: Array<{ toolName: string; summary: string }>;
      };
    };

    expect(created.status).toBe(201);
    expect(createdBody.session.id).toBe(createdBody.sessionId);
    expect(messageResponse.status).toBe(201);
    expect(messageBody.session.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Store this message through the mounted AaronDB seam."
      })
    ]);
    expect(toolEventResponse.status).toBe(201);
    expect(toolEventBody.session.toolEvents).toEqual([
      expect.objectContaining({
        toolName: "search",
        summary: "Stored a tool event through the mounted AaronDB seam."
      })
    ]);
    expect(stateResponse.status).toBe(200);
    expect(stateBody.session).toMatchObject({ id: createdBody.sessionId });
    expect(stateBody.session.messages).toHaveLength(1);
    expect(stateBody.session.toolEvents).toHaveLength(1);
  });

  it("returns the deterministic fallback when Workers AI is not bound", async () => {
    const { env } = createEnv();

    const created = await worker.fetch(
      new Request("https://aaronclaw.test/api/sessions", { method: "POST" }),
      env as Env
    );
    const createdBody = (await created.json()) as { sessionId: string };

    const chatted = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Fallback-only dogfood check" })
      }),
      env as Env
    );
    const chattedBody = (await chatted.json()) as {
      assistant: { content: string; source: string; fallbackReason: string | null };
    };

    expect(chatted.status).toBe(201);
    expect(chattedBody.assistant.source).toBe("fallback");
    expect(chattedBody.assistant.fallbackReason).toBe("no-ai-binding");
    expect(chattedBody.assistant.content).toContain("Workers AI is not bound");
  });

  it("surfaces a degraded fallback when Workers AI fails", async () => {
    const { env } = createEnv({ aiMode: "throw" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const created = await worker.fetch(
      new Request("https://aaronclaw.test/api/sessions", { method: "POST" }),
      env as Env
    );
    const createdBody = (await created.json()) as { sessionId: string };

    const chatted = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Cloudflare fallback degradation check" })
      }),
      env as Env
    );
    const chattedBody = (await chatted.json()) as {
      assistant: {
        content: string;
        source: string;
        model: string | null;
        fallbackReason: string | null;
        fallbackDetail: string | null;
      };
      session: {
        messages: Array<{
          metadata: Record<string, unknown> | null;
        }>;
      };
    };

    expect(chatted.status).toBe(201);
    expect(chattedBody.assistant.source).toBe("fallback");
    expect(chattedBody.assistant.model).toBe("@cf/meta/test-model");
    expect(chattedBody.assistant.fallbackReason).toBe("ai-error");
    expect(chattedBody.assistant.fallbackDetail).toContain("Workers AI unavailable");
    expect(chattedBody.assistant.content).toContain("failed for this request");
    expect(chattedBody.session.messages[1]?.metadata).toMatchObject({
      fallbackReason: "ai-error",
      fallbackDetail: expect.stringContaining("Workers AI unavailable")
    });
    expect(consoleError).toHaveBeenCalledWith(
      "workers ai request failed",
      expect.objectContaining({
        sessionId: createdBody.sessionId,
        model: "@cf/meta/test-model",
        fallbackDetail: expect.stringContaining("Workers AI unavailable")
      }),
      expect.any(Error)
    );
  });

  it("degrades predictably when Workers AI returns an empty payload", async () => {
    const { env } = createEnv({ aiMode: "empty" });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const created = await worker.fetch(
      new Request("https://aaronclaw.test/api/sessions", { method: "POST" }),
      env as Env
    );
    const createdBody = (await created.json()) as { sessionId: string };

    const chatted = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Please handle empty AI payloads safely" })
      }),
      env as Env
    );
    const chattedBody = (await chatted.json()) as {
      assistant: {
        content: string;
        source: string;
        fallbackReason: string | null;
        fallbackDetail: string | null;
      };
    };

    expect(chatted.status).toBe(201);
    expect(chattedBody.assistant.source).toBe("fallback");
    expect(chattedBody.assistant.fallbackReason).toBe("ai-empty-response");
    expect(chattedBody.assistant.fallbackDetail).toContain("Top-level payload keys");
    expect(chattedBody.assistant.content).toContain("returned an empty response for this request");
    expect(consoleWarn).toHaveBeenCalledWith(
      "workers ai returned no usable response text",
      expect.objectContaining({
        sessionId: createdBody.sessionId,
        model: "@cf/meta/test-model"
      })
    );
  });

  it("lists model availability and the active selection through the operator model route", async () => {
    const { env } = createEnv({ aiMode: "success", appAuthToken: "letmein" });

    const response = await worker.fetch(
      new Request("https://aaronclaw.test/api/model", {
        headers: {
          authorization: "Bearer letmein"
        }
      }),
      env as Env
    );
    const body = (await response.json()) as {
      persistedModelId: string | null;
      requestedModelId: string | null;
      activeModelId: string | null;
      selectionFallbackReason: string | null;
      models: Array<{
        id: string;
        provider: string;
        aliases: string[];
        selectable: boolean;
        availabilityStatus: string;
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.persistedModelId).toBeNull();
    expect(body.requestedModelId).toBe("gemini:gemini-3.1-pro-preview");
    expect(body.activeModelId).toBe("workers-ai:@cf/meta/test-model");
    expect(body.selectionFallbackReason).toBe("requested-model-unavailable");
    expect(body.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gemini:gemini-3.1-pro-preview",
          provider: "gemini",
          aliases: ["gemini:gemini-3.1-pro-flash-preview"],
          selectable: false,
          availabilityStatus: "missing-key"
        }),
        expect.objectContaining({
          id: "workers-ai:@cf/meta/test-model",
          provider: "workers-ai",
          aliases: [],
          selectable: true,
          availabilityStatus: "selectable"
        })
      ])
    );
  });

  it("requires APP_AUTH_TOKEN before protected provider key management can be used", async () => {
    const { env } = createEnv();

    const response = await worker.fetch(new Request("https://aaronclaw.test/api/key"), env as Env);
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(412);
    expect(body.error).toContain("APP_AUTH_TOKEN");
  });

  it("stores a validated Gemini key via the protected key route without echoing the raw secret", async () => {
    const { env } = createEnv({ aiMode: "success", appAuthToken: "letmein" });
    const geminiFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "models/gemini-3.1-pro-preview" }] }), {
        status: 200,
        headers: { "content-type": "application/json; charset=UTF-8" }
      })
    );
    const rawKey = "gemini-secret-1234";

    const response = await worker.fetch(
      new Request("https://aaronclaw.test/api/key", {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({ provider: "gemini", apiKey: rawKey })
      }),
      env as Env
    );
    const body = (await response.json()) as {
      provider: {
        configured: boolean;
        source: string;
        maskedKey: string | null;
        validation: { status: string; detail: string | null };
      };
    };

    expect(response.status).toBe(200);
    expect(body.provider).toMatchObject({
      configured: true,
      source: "protected-store",
      maskedKey: "••••••••1234",
      validation: {
        status: "valid"
      }
    });
    expect(JSON.stringify(body)).not.toContain(rawKey);
    expect(String(geminiFetch.mock.calls[0]?.[0] ?? "")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1"
    );
    expect(String(geminiFetch.mock.calls[0]?.[0] ?? "")).not.toContain(rawKey);
    expect(new Headers(geminiFetch.mock.calls[0]?.[1]?.headers).get("x-goog-api-key")).toBe(rawKey);

    const modelResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/model", {
        headers: {
          authorization: "Bearer letmein"
        }
      }),
      env as Env
    );
    const modelBody = (await modelResponse.json()) as {
      activeModelId: string | null;
      selectionFallbackReason: string | null;
      models: Array<{ id: string; availabilityStatus: string; selectable: boolean; routingStatus: string }>;
    };
    const geminiModel = modelBody.models.find((candidate) => candidate.id === "gemini:gemini-3.1-pro-preview");

    expect(modelBody.activeModelId).toBe("gemini:gemini-3.1-pro-preview");
    expect(modelBody.selectionFallbackReason).toBeNull();
    expect(geminiModel).toMatchObject({
      availabilityStatus: "selectable",
      selectable: true,
      routingStatus: "implemented"
    });
    await expect(
      readProviderKeyStatus({
        env,
        database: env.AARONDB as D1Database,
        provider: "gemini"
      })
    ).resolves.toMatchObject({
      configured: true,
      source: "protected-store",
      maskedKey: "••••••••1234"
    });
  });

  it("refuses to store an invalid Gemini key and keeps the provider unconfigured", async () => {
    const { env } = createEnv({ appAuthToken: "letmein" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } }), {
        status: 403,
        headers: { "content-type": "application/json; charset=UTF-8" }
      })
    );

    const response = await worker.fetch(
      new Request("https://aaronclaw.test/api/key", {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({ provider: "gemini", apiKey: "bad-key-0000" })
      }),
      env as Env
    );
    const body = (await response.json()) as {
      error: string;
      provider: { configured: boolean; validation: { status: string; detail: string | null } };
    };

    expect(response.status).toBe(400);
    expect(body.error).toContain("not stored");
    expect(body.provider).toMatchObject({
      configured: false,
      validation: {
        status: "invalid",
        detail: expect.stringContaining("API key not valid")
      }
    });
    await expect(
      readProviderKeyStatus({
        env,
        database: env.AARONDB as D1Database,
        provider: "gemini"
      })
    ).resolves.toMatchObject({ configured: false, source: "none" });
  });

  it("revalidates the current configured Gemini key without resubmitting the raw secret", async () => {
    const { env } = createEnv({ appAuthToken: "letmein" });
    const geminiFetch = vi.spyOn(globalThis, "fetch");
    geminiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ name: "models/gemini-3.1-pro-preview" }] }), {
        status: 200,
        headers: { "content-type": "application/json; charset=UTF-8" }
      })
    );
    geminiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ name: "models/gemini-3.1-pro-preview" }] }), {
        status: 200,
        headers: { "content-type": "application/json; charset=UTF-8" }
      })
    );

    await worker.fetch(
      new Request("https://aaronclaw.test/api/key", {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({ provider: "gemini", apiKey: "gemini-secret-5678" })
      }),
      env as Env
    );

    const response = await worker.fetch(
      new Request("https://aaronclaw.test/api/key", {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({ provider: "gemini", action: "validate" })
      }),
      env as Env
    );
    const body = (await response.json()) as {
      provider: { configured: boolean; validation: { status: string; detail: string | null } };
    };

    expect(response.status).toBe(200);
    expect(body.provider).toMatchObject({
      configured: true,
      validation: {
        status: "valid",
        detail: expect.stringContaining("first visible model")
      }
    });
    expect(geminiFetch).toHaveBeenCalledTimes(2);
  });

  it("persists an operator model selection through the model route", async () => {
    const { env } = createEnv({ aiMode: "success", appAuthToken: "letmein" });

    const response = await worker.fetch(
      new Request("https://aaronclaw.test/api/model", {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({ modelId: "workers-ai:@cf/meta/test-model" })
      }),
      env as Env
    );
    const body = (await response.json()) as {
      persistedModelId: string | null;
      activeModelId: string | null;
    };

    expect(response.status).toBe(200);
    expect(body.persistedModelId).toBe("workers-ai:@cf/meta/test-model");
    expect(body.activeModelId).toBe("workers-ai:@cf/meta/test-model");
    await expect(readPersistedModelSelection(env.AARONDB as D1Database)).resolves.toBe(
      "workers-ai:@cf/meta/test-model"
    );
  });

  it("refuses to select Gemini until its key state has been validated", async () => {
    const { env } = createEnv({
      aiMode: "success",
      appAuthToken: "letmein",
      geminiApiKey: "gemini-test-key"
    });

    const response = await worker.fetch(
      new Request("https://aaronclaw.test/api/model", {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({ modelId: "gemini:gemini-3.1-pro-flash-preview" })
      }),
      env as Env
    );
    const body = (await response.json()) as {
      error: string;
      model: { selectable: boolean; availabilityStatus: string };
    };

    expect(response.status).toBe(409);
    expect(body.error).toContain("not currently selectable");
    expect(body.model).toMatchObject({
      selectable: false,
      availabilityStatus: "configured-but-unavailable"
    });
  });

  it("allows selecting Gemini after a validated key is stored through the protected route", async () => {
    const { env } = createEnv({ aiMode: "success", appAuthToken: "letmein" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "models/gemini-3.1-pro-preview" }] }), {
        status: 200,
        headers: { "content-type": "application/json; charset=UTF-8" }
      })
    );

    await worker.fetch(
      new Request("https://aaronclaw.test/api/key", {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({ provider: "gemini", apiKey: "gemini-secret-1234" })
      }),
      env as Env
    );

    const response = await worker.fetch(
      new Request("https://aaronclaw.test/api/model", {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({ modelId: "gemini:gemini-3.1-pro-flash-preview" })
      }),
      env as Env
    );
    const body = (await response.json()) as {
      persistedModelId: string | null;
      activeModelId: string | null;
      selectionFallbackReason: string | null;
    };

    expect(response.status).toBe(200);
    expect(body.persistedModelId).toBe("gemini:gemini-3.1-pro-preview");
    expect(body.activeModelId).toBe("gemini:gemini-3.1-pro-preview");
    expect(body.selectionFallbackReason).toBeNull();
  });

  it("falls back to Workers AI when the default Gemini selection is unavailable", async () => {
    const { env } = createEnv({ aiMode: "success" });
    await setPersistedModelSelection(env.AARONDB as D1Database, "gemini:gemini-3.1-pro-flash-preview");

    const created = await worker.fetch(
      new Request("https://aaronclaw.test/api/sessions", { method: "POST" }),
      env as Env
    );
    const createdBody = (await created.json()) as { sessionId: string };

    const chatted = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Use the currently selected model if possible." })
      }),
      env as Env
    );
    const chattedBody = (await chatted.json()) as {
      assistant: { model: string | null; source: string };
      session: {
        messages: Array<{
          metadata: Record<string, unknown> | null;
        }>;
      };
    };

    expect(chatted.status).toBe(201);
    expect(chattedBody.assistant.source).toBe("workers-ai");
    expect(chattedBody.assistant.model).toBe("@cf/meta/test-model");
    expect((env.AI as FakeAiBinding).getLastRun()?.model).toBe("@cf/meta/test-model");
    expect(chattedBody.session.messages[1]?.metadata).toMatchObject({
      requestedModelId: "gemini:gemini-3.1-pro-preview",
      activeModelId: "workers-ai:@cf/meta/test-model",
      modelSelectionFallbackReason: "requested-model-unavailable"
    });
  });

  it("routes chat through Gemini after a validated Gemini key is selected", async () => {
    const { env } = createEnv({ aiMode: "success", appAuthToken: "letmein" });
    const geminiFetch = vi.spyOn(globalThis, "fetch");
    geminiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ name: "models/gemini-3.1-pro-preview" }] }), {
        status: 200,
        headers: { "content-type": "application/json; charset=UTF-8" }
      })
    );
    geminiFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "Gemini reply: external provider route is active." }]
              }
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json; charset=UTF-8" }
        }
      )
    );

    await worker.fetch(
      new Request("https://aaronclaw.test/api/key", {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({ provider: "gemini", apiKey: "gemini-secret-5678" })
      }),
      env as Env
    );
    await worker.fetch(
      new Request("https://aaronclaw.test/api/model", {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({ modelId: "gemini:gemini-3.1-pro-flash-preview" })
      }),
      env as Env
    );

    const created = await worker.fetch(
      new Request("https://aaronclaw.test/api/sessions", {
        method: "POST",
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );
    const createdBody = (await created.json()) as { sessionId: string };

    const chatted = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/chat`, {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({ content: "Use the validated Gemini route." })
      }),
      env as Env
    );
    const chattedBody = (await chatted.json()) as {
      assistant: { content: string; source: string; model: string | null; fallbackReason: string | null };
      session: { messages: Array<{ metadata: Record<string, unknown> | null }> };
    };

    expect(chatted.status).toBe(201);
    expect(chattedBody.assistant).toMatchObject({
      source: "gemini",
      model: "gemini-3.1-pro-preview",
      fallbackReason: null
    });
    expect(chattedBody.assistant.content).toContain("Gemini reply");
    expect((env.AI as FakeAiBinding).getLastRun()?.model).toBe("@cf/baai/bge-small-en-v1.5");
    expect(String(geminiFetch.mock.calls[1]?.[0] ?? "")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent"
    );
    expect(new Headers(geminiFetch.mock.calls[1]?.[1]?.headers).get("x-goog-api-key")).toBe(
      "gemini-secret-5678"
    );
    expect(chattedBody.session.messages[1]?.metadata).toMatchObject({
      source: "gemini",
      model: "gemini-3.1-pro-preview",
      activeModelId: "gemini:gemini-3.1-pro-preview"
    });
  });

  it("falls back to Workers AI when the selected Gemini route fails", async () => {
    const { env } = createEnv({ aiMode: "success", appAuthToken: "letmein" });
    const geminiFetch = vi.spyOn(globalThis, "fetch");
    geminiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ name: "models/gemini-3.1-pro-preview" }] }), {
        status: 200,
        headers: { "content-type": "application/json; charset=UTF-8" }
      })
    );
    geminiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Gemini upstream unavailable" } }), {
        status: 503,
        headers: { "content-type": "application/json; charset=UTF-8" }
      })
    );

    await worker.fetch(
      new Request("https://aaronclaw.test/api/key", {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({ provider: "gemini", apiKey: "gemini-secret-9012" })
      }),
      env as Env
    );

    const created = await worker.fetch(
      new Request("https://aaronclaw.test/api/sessions", {
        method: "POST",
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );
    const createdBody = (await created.json()) as { sessionId: string };

    const chatted = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/chat`, {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({ content: "Gemini first, Workers AI fallback." })
      }),
      env as Env
    );
    const chattedBody = (await chatted.json()) as {
      assistant: {
        content: string;
        source: string;
        model: string | null;
        fallbackReason: string | null;
        fallbackDetail: string | null;
      };
      session: { messages: Array<{ metadata: Record<string, unknown> | null }> };
    };

    expect(chatted.status).toBe(201);
    expect(chattedBody.assistant.source).toBe("workers-ai");
    expect(chattedBody.assistant.model).toBe("@cf/meta/test-model");
    expect(chattedBody.assistant.fallbackReason).toBe("provider-error");
    expect(chattedBody.assistant.fallbackDetail).toContain("Google Gemini request failed with status 503");
    expect(chattedBody.assistant.fallbackDetail).toContain("Fell back to Workers AI (@cf/meta/test-model)");
    expect((env.AI as FakeAiBinding).getLastRun()?.model).toBe("@cf/meta/test-model");
    expect(chattedBody.session.messages[1]?.metadata).toMatchObject({
      source: "workers-ai",
      fallbackReason: "provider-error",
      fallbackDetail: expect.stringContaining("Google Gemini request failed with status 503")
    });
  });

  it("falls back to Gemini when Workers AI fails and a validated Gemini route is available", async () => {
    const { env } = createEnv({ aiMode: "throw", appAuthToken: "letmein" });
    const geminiFetch = vi.spyOn(globalThis, "fetch");
    geminiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ name: "models/gemini-3.1-pro-preview" }] }), {
        status: 200,
        headers: { "content-type": "application/json; charset=UTF-8" }
      })
    );
    geminiFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "Gemini recovered this request after Workers AI failed." }]
              }
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json; charset=UTF-8" }
        }
      )
    );

    await worker.fetch(
      new Request("https://aaronclaw.test/api/key", {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({ provider: "gemini", apiKey: "gemini-secret-3456" })
      }),
      env as Env
    );
    await worker.fetch(
      new Request("https://aaronclaw.test/api/model", {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({ modelId: "workers-ai:@cf/meta/test-model" })
      }),
      env as Env
    );

    const created = await worker.fetch(
      new Request("https://aaronclaw.test/api/sessions", {
        method: "POST",
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );
    const createdBody = (await created.json()) as { sessionId: string };

    const chatted = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/chat`, {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({ content: "Recover this via Gemini if Workers AI fails." })
      }),
      env as Env
    );
    const chattedBody = (await chatted.json()) as {
      assistant: {
        content: string;
        source: string;
        model: string | null;
        fallbackReason: string | null;
        fallbackDetail: string | null;
      };
      session: { messages: Array<{ metadata: Record<string, unknown> | null }> };
    };

    expect(chatted.status).toBe(201);
    expect(chattedBody.assistant.source).toBe("gemini");
    expect(chattedBody.assistant.model).toBe("gemini-3.1-pro-preview");
    expect(chattedBody.assistant.fallbackReason).toBe("ai-error");
    expect(chattedBody.assistant.fallbackDetail).toContain("Workers AI request failed with Error: Workers AI unavailable");
    expect(chattedBody.assistant.fallbackDetail).toContain("Fell back to Google Gemini (gemini-3.1-pro-preview)");
    expect(chattedBody.assistant.content).toContain("Gemini recovered this request");
    expect(chattedBody.session.messages[1]?.metadata).toMatchObject({
      source: "gemini",
      fallbackReason: "ai-error",
      fallbackDetail: expect.stringContaining("Workers AI request failed with Error: Workers AI unavailable")
    });
  });

  it("requires a bearer token when APP_AUTH_TOKEN is configured", async () => {
    const { env } = createEnv({ appAuthToken: "letmein" });

    const unauthorizedResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/sessions", { method: "POST" }),
      env as Env
    );

    expect(unauthorizedResponse.status).toBe(401);

    const authorizedResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer letmein"
        }
      }),
      env as Env
    );

    expect(authorizedResponse.status).toBe(201);
  });

  it("reports runtime auth and fallback policy on the health endpoint", async () => {
    const { env } = createEnv({ appAuthToken: "letmein", aiMode: "success" });

    const response = await worker.fetch(
      new Request("https://aaronclaw.test/health"),
      env as Env
    );
    const body = (await response.json()) as {
      authMode: string;
      authBoundary: string;
      assistantRuntime: string;
      defaultModel: string | null;
      activeAssistantRuntime: string;
      activeModel: string | null;
      assistantBindingStatus: string;
      assistantFallbackBehavior: string;
      selectionFallbackReason: string | null;
    };

    expect(response.status).toBe(200);
    expect(body.authMode).toBe("bearer-token");
    expect(body.authBoundary).toContain("Landing page stays public");
    expect(body.assistantRuntime).toBe("gemini");
    expect(body.defaultModel).toBe("gemini-3.1-pro-preview");
    expect(body.activeAssistantRuntime).toBe("workers-ai");
    expect(body.activeModel).toBe("@cf/meta/test-model");
    expect(body.assistantBindingStatus).toBe("configured");
    expect(body.assistantFallbackBehavior).toContain("Gemini remains the default operator-facing model path");
    expect(body.selectionFallbackReason).toBe("requested-model-unavailable");
  });

  it("reports Gemini as the active default model path on health after key validation", async () => {
    const { env } = createEnv({ appAuthToken: "letmein", aiMode: "success" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "models/gemini-3.1-pro-preview" }] }), {
        status: 200,
        headers: { "content-type": "application/json; charset=UTF-8" }
      })
    );

    await worker.fetch(
      new Request("https://aaronclaw.test/api/key", {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({ provider: "gemini", apiKey: "gemini-secret-7890" })
      }),
      env as Env
    );

    const response = await worker.fetch(
      new Request("https://aaronclaw.test/health"),
      env as Env
    );
    const body = (await response.json()) as {
      assistantRuntime: string;
      defaultModel: string | null;
      activeAssistantRuntime: string;
      activeModel: string | null;
      selectionFallbackReason: string | null;
    };

    expect(response.status).toBe(200);
    expect(body.assistantRuntime).toBe("gemini");
    expect(body.defaultModel).toBe("gemini-3.1-pro-preview");
    expect(body.activeAssistantRuntime).toBe("gemini");
    expect(body.activeModel).toBe("gemini-3.1-pro-preview");
    expect(body.selectionFallbackReason).toBeNull();
  });

  it("runs scheduled maintenance and persists a morning briefing session", async () => {
    const { env, database } = createEnv();

    await seedHistoricalSession(
      database,
      "history-4",
      "Morning maintenance should review recent reasoning evidence for AaronDB sessions."
    );
    const activationResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/hands/scheduled-maintenance/activate", {
        method: "POST"
      }),
      env as Env
    );

    expect(activationResponse.status).toBe(200);

    await worker.scheduled?.(
      {
        cron: "0 8 * * *",
        noRetry() {},
        scheduledTime: Date.parse("2026-03-09T08:00:00.000Z"),
        type: "scheduled"
      } as ScheduledController,
      env as Env
    );

    const maintenanceRepository = new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      "maintenance:briefing:2026-03-09"
    );
    const briefingSession = await maintenanceRepository.getSession();
    const handResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/hands/scheduled-maintenance"),
      env as Env
    );
    const handBody = (await handResponse.json()) as {
      hand: {
        status: string;
        latestRun: {
          cron: string;
          maintenanceSessionId: string | null;
          status: string;
        } | null;
        recentAudit: Array<{
          toolName: string;
          capability: string | null;
          outcome: string | null;
        }>;
      };
    };

    expect(briefingSession?.toolEvents[0]).toMatchObject({
      toolName: "morning-briefing"
    });
    expect(briefingSession?.toolEvents[0]?.summary).toContain("Morning briefing");
    expect(briefingSession?.toolEvents[0]?.metadata).toMatchObject({
      audit: {
        toolId: "morning-briefing",
        policy: "scheduled-safe",
        capability: "maintenance.run.briefing",
        outcome: "succeeded"
      }
    });
    expect(handResponse.status).toBe(200);
    expect(handBody.hand.status).toBe("active");
    expect(handBody.hand.latestRun).toMatchObject({
      cron: "0 8 * * *",
      maintenanceSessionId: "maintenance:briefing:2026-03-09",
      status: "succeeded"
    });
    expect(handBody.hand.recentAudit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "hand-run",
          capability: "hand.execute.scheduled",
          outcome: "succeeded"
        }),
        expect.objectContaining({
          toolName: "hand-lifecycle",
          capability: "operator.control.hands",
          outcome: "succeeded"
        })
      ])
    );

    const handRepository = new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      "hand:scheduled-maintenance"
    );
    const handSession = await handRepository.getSession();

    expect(handSession?.toolEvents[0]?.metadata).toMatchObject({
      audit: {
        toolId: "hand-lifecycle",
        policy: "operator-protected",
        capability: "operator.control.hands",
        outcome: "succeeded"
      }
    });
    expect(handSession?.toolEvents[1]?.metadata).toMatchObject({
      audit: {
        toolId: "hand-run",
        policy: "scheduled-safe",
        capability: "hand.execute.scheduled",
        outcome: "succeeded"
      }
    });
  });

  it("lists, activates, and pauses the bundled hands runtime without affecting chat routes", async () => {
    const { env } = createEnv({ appAuthToken: "letmein" });

    const listResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/hands", {
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );
    const listBody = (await listResponse.json()) as {
      hands: Array<{ id: string; status: string; persisted: boolean }>;
    };

    const activatedResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/hands/scheduled-maintenance/activate", {
        method: "POST",
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );
    const activatedBody = (await activatedResponse.json()) as {
      hand: {
        id: string;
        status: string;
        persisted: boolean;
        recentRuns: unknown[];
        recentAudit: Array<{ toolName: string; policy: string | null; capability: string | null }>;
      };
    };

    const pausedResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/hands/scheduled-maintenance/pause", {
        method: "POST",
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );
    const pausedBody = (await pausedResponse.json()) as {
      hand: { id: string; status: string; persisted: boolean };
    };

    expect(listResponse.status).toBe(200);
    expect(listBody.hands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "scheduled-maintenance",
          status: "paused",
          persisted: false
        }),
        expect.objectContaining({
          id: "improvement-hand",
          status: "paused",
          persisted: false
        }),
        expect.objectContaining({
          id: "user-correction-miner",
          status: "paused",
          persisted: false
        }),
        expect.objectContaining({
          id: "regression-watch",
          status: "paused",
          persisted: false
        }),
        expect.objectContaining({
          id: "provider-health-watchdog",
          status: "paused",
          persisted: false
        }),
        expect.objectContaining({
          id: "docs-drift",
          status: "paused",
          persisted: false
        })
      ])
    );
    expect(activatedResponse.status).toBe(200);
    expect(activatedBody.hand).toMatchObject({
      id: "scheduled-maintenance",
      status: "active",
      persisted: true
    });
    expect(activatedBody.hand.recentRuns).toEqual([]);
    expect(activatedBody.hand.recentAudit[0]).toMatchObject({
      toolName: "hand-lifecycle",
      policy: "operator-protected",
      capability: "operator.control.hands"
    });
    expect(pausedResponse.status).toBe(200);
    expect(pausedBody.hand).toMatchObject({
      id: "scheduled-maintenance",
      status: "paused",
      persisted: true
    });
  });

  it("runs the Improvement Hand against stored reflections and persists deduped structured proposals", async () => {
    const { env, database } = createEnv({ appAuthToken: "letmein" });

    // Phase 6 improvement: Mock fetch to stabilize the recursive evolution spawn path in tests
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    await seedHistoricalSession(
      database,
      "history-improvement",
      "Please verify with evidence why the route keeps falling back before you answer."
    );
    await reflectSession({ env, sessionId: "history-improvement", timestamp: "2026-03-09T07:55:00.000Z" });

    const activatedResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/hands/improvement-hand/activate", {
        method: "POST",
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );

    expect(activatedResponse.status).toBe(200);

    await worker.scheduled?.(
      {
        cron: "*/30 * * * *",
        noRetry() {},
        scheduledTime: Date.parse("2026-03-09T08:00:00.000Z"),
        type: "scheduled"
      } as ScheduledController,
      env as Env
    );

    const proposalRepository = new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      "improvement:proposals"
    );
    const proposalSession = await proposalRepository.getSession();
    const handResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/hands/improvement-hand", {
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );
    const handBody = (await handResponse.json()) as {
      hand: {
        status: string;
        latestRun: {
          status: string;
          proposalSessionId: string | null;
          reviewedSignalCount: number;
          generatedProposalCount: number;
	          evaluatedProposalCount: number;
	          awaitingApprovalCount: number;
          skippedDuplicateProposalCount: number;
        } | null;
      };
    };

    expect(handResponse.status).toBe(200);
    expect(handBody.hand.status).toBe("active");
    expect(handBody.hand.latestRun).toMatchObject({
      status: "succeeded",
      proposalSessionId: "improvement:proposals",
      reviewedSignalCount: 1,
      generatedProposalCount: 1,
	      evaluatedProposalCount: 1,
	      awaitingApprovalCount: 1,
      skippedDuplicateProposalCount: 0
    });
	    expect(proposalSession?.toolEvents).toHaveLength(2);
    expect(proposalSession?.toolEvents[0]?.metadata).toMatchObject({
      audit: {
        toolId: "improvement-proposal-review",
        capability: "improvement.propose.reflection",
        policy: "scheduled-safe",
        outcome: "succeeded"
      },
      generatedProposalCount: 1,
      reviewedSignalCount: 1,
      proposals: [
        expect.objectContaining({
          candidateKey: "promote-evidence-backed-pattern",
          proposalKey: "reflection:history-improvement@3:promote-evidence-backed-pattern",
          sourceReflectionSessionId: "reflection:history-improvement",
          sourceSessionId: "history-improvement",
          sourceLastTx: 3,
          problemStatement:
            "The session paired evidence-seeking language with a persisted tool trace that future foundation work can reuse.",
          proposedAction:
            "Promote the current evidence-backed reasoning pattern into a reusable skill/maintenance prompt contract.",
          expectedBenefit:
            "Captures a successful evidence-backed behavior in a reusable form without mutating live production behavior directly.",
          riskLevel: "low",
          verificationPlan:
            "Verify the promoted contract still preserves the existing chat, hands, and Telegram behavior when idle."
        })
      ]
    });
	    expect(proposalSession?.toolEvents[1]?.metadata).toMatchObject({
	      audit: {
	        toolId: "improvement-shadow-evaluation",
	        capability: "improvement.evaluate.shadow",
	        policy: "scheduled-safe",
	        outcome: "succeeded"
	      },
	      evaluatedProposalCount: 1,
	      awaitingApprovalCount: 1,
	      evaluationMode: "bounded-metadata-shadow",
	      proposals: [
	        expect.objectContaining({
	          proposalKey: "reflection:history-improvement@3:promote-evidence-backed-pattern",
	          status: "awaiting-approval",
	          shadowEvaluation: expect.objectContaining({
	            status: "completed",
	            verdict: "awaiting-approval"
	          }),
	          approval: expect.objectContaining({
	            requiresProtectedApproval: true,
	            status: "pending"
	          }),
	          promotion: expect.objectContaining({
	            status: "not-promoted",
	            productionMutation: "manual-only",
	            liveMutationApplied: false
	          }),
	          lifecycleHistory: expect.arrayContaining([
	            expect.objectContaining({ action: "propose", toStatus: "proposed" }),
	            expect.objectContaining({ action: "start-shadow", toStatus: "shadowing" }),
	            expect.objectContaining({ action: "complete-shadow", toStatus: "awaiting-approval" })
	          ])
	        })
	      ]
	    });

    await worker.scheduled?.(
      {
        cron: "*/30 * * * *",
        noRetry() {},
        scheduledTime: Date.parse("2026-03-09T08:30:00.000Z"),
        type: "scheduled"
      } as ScheduledController,
      env as Env
    );

    const proposalSessionAfterReplay = await proposalRepository.getSession();
    const improvementHandRepository = new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      "hand:improvement-hand"
    );
    const improvementHandSession = await improvementHandRepository.getSession();

	    expect(proposalSessionAfterReplay?.toolEvents).toHaveLength(2);
    expect(improvementHandSession?.toolEvents[2]?.metadata).toMatchObject({
	      awaitingApprovalCount: 0,
	      evaluatedProposalCount: 0,
      generatedProposalCount: 0,
      reviewedSignalCount: 1,
      skippedDuplicateProposalCount: 1,
      audit: {
        toolId: "hand-run",
        policy: "scheduled-safe",
        capability: "hand.execute.scheduled",
        outcome: "succeeded"
      }
    });
  });

  it("lists, inspects, pauses, approves, and rejects improvement candidates through protected routes", async () => {
    const { env, database } = createEnv({ appAuthToken: "letmein" });

    await seedHistoricalSession(
      database,
      "history-improvement-routes",
      "Please verify with evidence why the route keeps falling back before you answer."
    );
    await reflectSession({ env, sessionId: "history-improvement-routes", timestamp: "2026-03-09T07:55:00.000Z" });

    await worker.fetch(
      new Request("https://aaronclaw.test/api/hands/improvement-hand/activate", {
        method: "POST",
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );

    await worker.scheduled?.(
      {
        cron: "*/30 * * * *",
        noRetry() {},
        scheduledTime: Date.parse("2026-03-09T08:00:00.000Z"),
        type: "scheduled"
      } as ScheduledController,
      env as Env
    );

    const listResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/improvements", {
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );
    const listBody = (await listResponse.json()) as {
      proposals: Array<{
        proposalKey: string;
        status: string;
        evidence: Array<{ summary: string }>;
        lifecycleHistory: Array<{ action: string; toStatus: string }>;
      }>;
    };
    const proposalKey = listBody.proposals[0]?.proposalKey;

    expect(listResponse.status).toBe(200);
    expect(listBody.proposals[0]?.status).toBe("awaiting-approval");
    expect(listBody.proposals[0]?.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ summary: expect.any(String) })])
    );
    expect(listBody.proposals[0]?.lifecycleHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "complete-shadow", toStatus: "awaiting-approval" })
      ])
    );
    expect(proposalKey).toBeTruthy();

    const detailResponse = await worker.fetch(
      new Request(`https://aaronclaw.test/api/improvements/${encodeURIComponent(proposalKey!)}`, {
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );
    const detailBody = (await detailResponse.json()) as {
      proposal: {
        proposalKey: string;
        status: string;
        approval: { status: string };
      };
    };

    expect(detailResponse.status).toBe(200);
    expect(detailBody.proposal).toMatchObject({
      proposalKey,
      status: "awaiting-approval",
      approval: { status: "pending" }
    });

    const pausedResponse = await worker.fetch(
      new Request(`https://aaronclaw.test/api/improvements/${encodeURIComponent(proposalKey!)}/pause`, {
        method: "POST",
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );
    const pausedBody = (await pausedResponse.json()) as { proposal: { status: string } };
    expect(pausedResponse.status).toBe(200);
    expect(pausedBody.proposal.status).toBe("paused");

    const approvedResponse = await worker.fetch(
      new Request(`https://aaronclaw.test/api/improvements/${encodeURIComponent(proposalKey!)}/approve`, {
        method: "POST",
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );
    const approvedBody = (await approvedResponse.json()) as { proposal: { status: string } };
    expect(approvedResponse.status).toBe(200);
    expect(approvedBody.proposal.status).toBe("approved");

    const rejectedResponse = await worker.fetch(
      new Request(`https://aaronclaw.test/api/improvements/${encodeURIComponent(proposalKey!)}/reject`, {
        method: "POST",
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );
    const rejectedBody = (await rejectedResponse.json()) as {
      proposal: {
        status: string;
        lifecycleHistory: Array<{ action: string; toStatus: string }>;
      };
    };

    expect(rejectedResponse.status).toBe(200);
    expect(rejectedBody.proposal).toMatchObject({
      status: "rejected",
      lifecycleHistory: expect.arrayContaining([
        expect.objectContaining({ action: "pause", toStatus: "paused" }),
        expect.objectContaining({ action: "approve", toStatus: "approved" }),
        expect.objectContaining({ action: "reject", toStatus: "rejected" })
      ])
    });
  });

  it("records shadow evaluation plus pause, approval, promotion, rejection, and rollback markers for stored proposals", async () => {
    const { env, database } = createEnv();

    await seedFallbackReflectionSession(database, env, "history-shadow-lifecycle", "ai-error", "knowledge-vault");

    const proposalReview = await runScheduledImprovementProposalReview({
      env,
      cron: "*/30 * * * *",
      timestamp: "2026-03-09T09:00:00.000Z"
    });
    const shadowEvaluation = await runScheduledImprovementShadowEvaluation({
      env,
      cron: "*/30 * * * *",
      timestamp: "2026-03-09T09:00:01.000Z"
    });
    const initialState = await readImprovementProposalState({ env });

    expect(proposalReview.generatedProposalCount).toBeGreaterThanOrEqual(2);
    expect(shadowEvaluation.evaluatedProposalCount).toBe(proposalReview.generatedProposalCount);
    expect(shadowEvaluation.awaitingApprovalCount).toBe(proposalReview.generatedProposalCount);
    expect(initialState.proposalSessionId).toBe(IMPROVEMENT_PROPOSAL_SESSION_ID);
    expect(initialState.proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateKey: "stabilize-degraded-tool-path",
          status: "awaiting-approval"
        }),
        expect.objectContaining({
          candidateKey: "track-and-reduce-fallback-frequency",
          status: "awaiting-approval"
        })
      ])
    );

    const degradedProposal = initialState.proposals.find(
      (proposal) => proposal.candidateKey === "stabilize-degraded-tool-path"
    );
    const fallbackProposal = initialState.proposals.find(
      (proposal) => proposal.candidateKey === "track-and-reduce-fallback-frequency"
    );

    expect(degradedProposal).toBeDefined();
    expect(fallbackProposal).toBeDefined();

    await expect(
      recordImprovementLifecycleAction({
        env,
        proposalKey: fallbackProposal!.proposalKey,
        action: "promote",
        timestamp: "2026-03-09T09:00:02.000Z"
      })
    ).rejects.toThrow("must be approved before promotion");

    const pausedProposal = await recordImprovementLifecycleAction({
      env,
      proposalKey: fallbackProposal!.proposalKey,
      action: "pause",
      timestamp: "2026-03-09T09:00:02.000Z"
    });
    const approvedProposal = await recordImprovementLifecycleAction({
      env,
      proposalKey: fallbackProposal!.proposalKey,
      action: "approve",
      timestamp: "2026-03-09T09:00:03.000Z"
    });
    const promotedProposal = await recordImprovementLifecycleAction({
      env,
      proposalKey: fallbackProposal!.proposalKey,
      action: "promote",
      timestamp: "2026-03-09T09:00:04.000Z"
    });
    const rolledBackProposal = await recordImprovementLifecycleAction({
      env,
      proposalKey: fallbackProposal!.proposalKey,
      action: "rollback",
      timestamp: "2026-03-09T09:00:05.000Z"
    });
    const rejectedProposal = await recordImprovementLifecycleAction({
      env,
      proposalKey: degradedProposal!.proposalKey,
      action: "reject",
      timestamp: "2026-03-09T09:00:06.000Z"
    });
    const finalState = await readImprovementProposalState({ env });
    const proposalSession = await new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      IMPROVEMENT_PROPOSAL_SESSION_ID
    ).getSession();

    expect(pausedProposal.status).toBe("paused");
    expect(approvedProposal.status).toBe("approved");
    expect(promotedProposal).toMatchObject({
      status: "promoted",
      promotion: {
        status: "promoted",
        productionMutation: "manual-only",
        liveMutationApplied: false
      }
    });
    expect(rolledBackProposal.status).toBe("rolled-back");
    expect(rejectedProposal.status).toBe("rejected");
    expect(finalState.proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          proposalKey: fallbackProposal!.proposalKey,
          status: "rolled-back",
          lifecycleHistory: expect.arrayContaining([
              expect.objectContaining({ action: "pause", toStatus: "paused" }),
            expect.objectContaining({ action: "approve", toStatus: "approved" }),
            expect.objectContaining({ action: "promote", toStatus: "promoted" }),
            expect.objectContaining({ action: "rollback", toStatus: "rolled-back" })
          ])
        }),
        expect.objectContaining({
          proposalKey: degradedProposal!.proposalKey,
          status: "rejected",
          lifecycleHistory: expect.arrayContaining([
            expect.objectContaining({ action: "reject", toStatus: "rejected" })
          ])
        })
      ])
    );
    expect(proposalSession?.toolEvents).toHaveLength(7);
    expect(proposalSession?.toolEvents[2]?.metadata).toMatchObject({
      action: "pause",
      audit: {
        toolId: "improvement-candidate-review",
        capability: "operator.control.improvements",
        policy: "operator-protected",
        outcome: "succeeded"
      }
    });
    expect(proposalSession?.toolEvents[3]?.metadata).toMatchObject({
      action: "approve",
      audit: {
        toolId: "improvement-candidate-review",
        capability: "operator.control.improvements",
        policy: "operator-protected",
        outcome: "succeeded"
      }
    });
    expect(proposalSession?.toolEvents[6]?.metadata).toMatchObject({
      action: "reject",
      proposals: [
        expect.objectContaining({
          proposalKey: degradedProposal!.proposalKey,
          status: "rejected"
        })
      ]
    });
  });

  it("runs the User Correction Miner and routes repeated correction signals into the review-only proposal store", async () => {
    const { env, database } = createEnv({ appAuthToken: "letmein" });

    await seedCorrectionSession(database, {
      sessionId: "correction-1",
      prompt: "Why did the route fail?",
      assistant: "It probably failed because the upstream was slow.",
      correction: "No, verify it with evidence and inspect the actual trace before you conclude."
    });
    await seedCorrectionSession(database, {
      sessionId: "correction-2",
      prompt: "What caused the fallback?",
      assistant: "It fell back because the tool likely timed out.",
      correction: "Please show evidence and inspect the actual trace before answering."
    });

    const activatedResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/hands/user-correction-miner/activate", {
        method: "POST",
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );

    expect(activatedResponse.status).toBe(200);

    await worker.scheduled?.(
      {
        cron: "*/30 * * * *",
        noRetry() {},
        scheduledTime: Date.parse("2026-03-09T08:00:00.000Z"),
        type: "scheduled"
      } as ScheduledController,
      env as Env
    );

    const proposalRepository = new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      "improvement:proposals"
    );
    const proposalSession = await proposalRepository.getSession();
    const handResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/hands/user-correction-miner", {
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );
    const handBody = (await handResponse.json()) as {
      hand: {
        status: string;
        latestRun: {
          status: string;
          proposalSessionId: string | null;
          correctionSignalCount: number;
          matchedCorrectionCount: number;
          generatedProposalCount: number;
          skippedDuplicateProposalCount: number;
        } | null;
      };
    };

    expect(handResponse.status).toBe(200);
    expect(handBody.hand.status).toBe("active");
    expect(handBody.hand.latestRun).toMatchObject({
      status: "succeeded",
      proposalSessionId: "improvement:proposals",
      correctionSignalCount: 1,
      matchedCorrectionCount: 2,
      generatedProposalCount: 1,
      skippedDuplicateProposalCount: 0
    });
    expect(proposalSession?.toolEvents).toHaveLength(1);
    expect(proposalSession?.toolEvents[0]?.metadata).toMatchObject({
      sourceHandId: "user-correction-miner",
      audit: {
        toolId: "improvement-proposal-review",
        capability: "improvement.propose.reflection",
        policy: "scheduled-safe",
        outcome: "succeeded",
        handId: "user-correction-miner"
      },
      correctionSignalCount: 1,
      matchedCorrectionCount: 2,
      generatedProposalCount: 1,
      proposals: [
        expect.objectContaining({
          candidateKey: "strengthen-evidence-contract-from-corrections",
          proposalKey:
            "user-correction-miner:evidence-contract:strengthen-evidence-contract-from-corrections",
          sourceHandId: "user-correction-miner"
        })
      ],
      correctionSignals: [
        expect.objectContaining({
          signalKey: "repeated-user-correction-evidence-contract",
          repeatedCorrectionCount: 2,
          evidence: expect.arrayContaining([
            expect.objectContaining({ kind: "metric" }),
            expect.objectContaining({
              kind: "message",
              excerpt: expect.stringContaining("verify it with evidence")
            })
          ])
        })
      ]
    });

    await worker.scheduled?.(
      {
        cron: "*/30 * * * *",
        noRetry() {},
        scheduledTime: Date.parse("2026-03-09T08:30:00.000Z"),
        type: "scheduled"
      } as ScheduledController,
      env as Env
    );

    const proposalSessionAfterReplay = await proposalRepository.getSession();
    const correctionMinerRepository = new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      "hand:user-correction-miner"
    );
    const correctionMinerSession = await correctionMinerRepository.getSession();

    expect(proposalSessionAfterReplay?.toolEvents).toHaveLength(1);
    expect(correctionMinerSession?.toolEvents[2]?.metadata).toMatchObject({
      correctionSignalCount: 1,
      matchedCorrectionCount: 2,
      generatedProposalCount: 0,
      skippedDuplicateProposalCount: 1,
      audit: {
        toolId: "hand-run",
        policy: "scheduled-safe",
        capability: "hand.execute.scheduled",
        outcome: "succeeded"
      }
    });
  });

  it("runs the provider-health watchdog hand and persists structured operator-visible findings", async () => {
    const { env } = createEnv({
      aiMode: "success",
      appAuthToken: "letmein",
      telegramBotToken: "telegram-test-token",
      telegramWebhookSecret: "telegram-secret"
    });

    await setPersistedModelSelection(env.AARONDB as D1Database, "gemini:gemini-3.1-pro-flash-preview");

    const chatRepository = new AaronDbEdgeSessionRepository(env.AARONDB as D1Database, "session-watchdog-chat");
    await chatRepository.createSession("2026-03-09T07:40:00.000Z");
    await chatRepository.appendMessage({
      timestamp: "2026-03-09T07:41:00.000Z",
      role: "user",
      content: "Why did the chat route fall back?"
    });
    const chatSession = await chatRepository.appendMessage({
      timestamp: "2026-03-09T07:42:00.000Z",
      role: "assistant",
      content: "The runtime used fallback for this chat request.",
      metadata: {
        fallbackReason: "ai-error",
        fallbackDetail: "Workers AI request failed in the recent chat path.",
        source: "fallback"
      }
    });
    await reflectSession({
      env,
      sessionId: "session-watchdog-chat",
      session: chatSession,
      timestamp: "2026-03-09T07:43:00.000Z"
    });

    const telegramSessionId = buildTelegramSessionId({
      messageId: 77,
      date: 1_741_552_900,
      text: "telegram route check",
      chat: { id: 88, type: "private", username: "telegram_watchdog" },
      from: {
        id: 99,
        isBot: false,
        username: "telegram_watchdog_user",
        firstName: "Telegram",
        lastName: "Watchdog"
      }
    });
    const telegramRepository = new AaronDbEdgeSessionRepository(env.AARONDB as D1Database, telegramSessionId);
    await telegramRepository.createSession("2026-03-09T07:44:00.000Z");
    await telegramRepository.appendMessage({
      timestamp: "2026-03-09T07:45:00.000Z",
      role: "user",
      content: "telegram route check",
      metadata: { channel: "telegram" }
    });
    const telegramSession = await telegramRepository.appendMessage({
      timestamp: "2026-03-09T07:46:00.000Z",
      role: "assistant",
      content: "Telegram degraded to fallback.",
      metadata: {
        channel: "telegram",
        fallbackReason: "provider-error",
        fallbackDetail: "Google Gemini request failed with status 503.",
        source: "fallback"
      }
    });
    await reflectSession({
      env,
      sessionId: telegramSessionId,
      session: telegramSession,
      timestamp: "2026-03-09T07:47:00.000Z"
    });

    const activatedResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/hands/provider-health-watchdog/activate", {
        method: "POST",
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );

    expect(activatedResponse.status).toBe(200);

    await worker.scheduled?.(
      {
        cron: "*/30 * * * *",
        noRetry() {},
        scheduledTime: Date.parse("2026-03-09T08:00:00.000Z"),
        type: "scheduled"
      } as ScheduledController,
      env as Env
    );

    const signalSession = await new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      "improvement:provider-health-signals"
    ).getSession();
    const handResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/hands/provider-health-watchdog", {
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );
    const handBody = (await handResponse.json()) as {
      hand: {
        status: string;
        latestRun: {
          status: string;
          signalSessionId: string | null;
          healthyCount: number;
          degradedCount: number;
          unavailableCount: number;
          providerHealthFindings: Array<{ findingKey: string; surface: string; status: string }>;
        } | null;
      };
    };

    expect(handResponse.status).toBe(200);
    expect(handBody.hand.status).toBe("active");
    expect(handBody.hand.latestRun).toMatchObject({
      status: "succeeded",
      signalSessionId: "improvement:provider-health-signals",
      healthyCount: 0,
      degradedCount: 3,
      unavailableCount: 2
    });
    expect(handBody.hand.latestRun?.providerHealthFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          findingKey: "gemini-key-readiness",
          surface: "provider-key",
          status: "unavailable"
        }),
        expect.objectContaining({
          findingKey: "assistant-model-selection",
          surface: "model-selection",
          status: "degraded"
        }),
        expect.objectContaining({
          findingKey: "chat-route-fallback-watch",
          surface: "chat-route",
          status: "degraded"
        }),
        expect.objectContaining({
          findingKey: "telegram-route-watch",
          surface: "telegram-route",
          status: "degraded"
        })
      ])
    );
    expect(signalSession?.toolEvents[0]?.metadata).toMatchObject({
      degradedCount: 3,
      unavailableCount: 2,
      selectionFallbackReason: "requested-model-unavailable",
      findings: expect.arrayContaining([
        expect.objectContaining({ findingKey: "gemini-key-readiness" }),
        expect.objectContaining({ findingKey: "assistant-model-selection" }),
        expect.objectContaining({ findingKey: "chat-route-fallback-watch" }),
        expect.objectContaining({ findingKey: "telegram-route-watch" })
      ])
    });

    const watchdogHandSession = await new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      "hand:provider-health-watchdog"
    ).getSession();
    expect(watchdogHandSession?.toolEvents[1]?.metadata).toMatchObject({
      degradedCount: 3,
      unavailableCount: 2,
      signalSessionId: "improvement:provider-health-signals",
      audit: {
        toolId: "hand-run",
        policy: "scheduled-safe",
        capability: "hand.execute.scheduled",
        outcome: "succeeded"
      }
    });
  });

  it("generates bounded docs-drift findings when the docs contract lags shipped hands", async () => {
    const { env } = createEnv();

    const review = await runScheduledDocsDriftReview({
      env,
      cron: "*/30 * * * *",
      contract: {
        ...defaultDocsContract,
        documentedHands: {
          ...defaultDocsContract.documentedHands,
          values: ["scheduled-maintenance", "improvement-hand"]
        }
      }
    });

    expect(review.reviewedDocumentCount).toBe(2);
    expect(review.reviewedClaimCount).toBe(4);
    expect(review.findingCount).toBe(1);
    expect(review.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          findingKey: "docs-drift:bundled-hands",
          kind: "hand-posture",
          severity: "medium"
        })
      ])
    );
    expect(review.findings[0]?.summary).toContain("docs-drift");
    expect(review.findings[0]?.summary).toContain("provider-health-watchdog");
  });

  it("runs the docs drift hand and persists reviewable finding metadata on the hand surface", async () => {
    const { env } = createEnv({ appAuthToken: "letmein" });

    const activatedResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/hands/docs-drift/activate", {
        method: "POST",
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );

    expect(activatedResponse.status).toBe(200);

    await worker.scheduled?.(
      {
        cron: "*/30 * * * *",
        noRetry() {},
        scheduledTime: Date.parse("2026-03-09T08:00:00.000Z"),
        type: "scheduled"
      } as ScheduledController,
      env as Env
    );

    const handResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/hands/docs-drift", {
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );
    const handBody = (await handResponse.json()) as {
      hand: {
        status: string;
        latestRun: {
          status: string;
          reviewedDocumentCount: number;
          reviewedClaimCount: number;
          findingCount: number;
          findings: Array<{ findingKey: string }>;
        } | null;
      };
    };

    expect(handResponse.status).toBe(200);
    expect(handBody.hand.status).toBe("active");
    expect(handBody.hand.latestRun).toMatchObject({
      status: "succeeded",
      reviewedDocumentCount: 2,
      reviewedClaimCount: 4
    });
    expect(typeof handBody.hand.latestRun?.findingCount).toBe("number");

    const docsDriftSession = await new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      "hand:docs-drift"
    ).getSession();
    expect(docsDriftSession?.toolEvents[1]?.metadata).toMatchObject({
      reviewedDocumentCount: 2,
      reviewedClaimCount: 4,
      audit: {
        toolId: "hand-run",
        policy: "scheduled-safe",
        capability: "hand.execute.scheduled",
        outcome: "succeeded"
      }
    });
  });

  it("runs Regression Watch against stored regression evidence and persists bounded findings for operator review", async () => {
    const { env, database } = createEnv({ appAuthToken: "letmein" });

    await seedFallbackReflectionSession(
      database,
      env,
      "history-regression-1",
      "ai-error",
      "knowledge-vault"
    );
    await seedFallbackReflectionSession(
      database,
      env,
      "history-regression-2",
      "route-timeout",
      "runtime-state"
    );

    const failedHandRepository = new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      "hand:improvement-hand"
    );
    await failedHandRepository.createSession("2026-03-09T07:54:00.000Z");
    await failedHandRepository.appendToolEvent({
      timestamp: "2026-03-09T07:54:30.000Z",
      toolName: "hand-run",
      summary: "Improvement Hand failed for cron */30 * * * *: provider timeout",
      metadata: {
        action: "run",
        cron: "*/30 * * * *",
        error: "provider timeout",
        handId: "improvement-hand",
        status: "failed"
      }
    });

    const activatedResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/hands/regression-watch/activate", {
        method: "POST",
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );

    expect(activatedResponse.status).toBe(200);

    await worker.scheduled?.(
      {
        cron: "*/30 * * * *",
        noRetry() {},
        scheduledTime: Date.parse("2026-03-09T08:00:00.000Z"),
        type: "scheduled"
      } as ScheduledController,
      env as Env
    );

    const proposalRepository = new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      "improvement:proposals"
    );
    const proposalSession = await proposalRepository.getSession();
    const handResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/hands/regression-watch", {
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );
    const handBody = (await handResponse.json()) as {
      hand: {
        status: string;
        latestRun: {
          status: string;
          proposalSessionId: string | null;
          reviewedSignalCount: number;
          generatedProposalCount: number;
          skippedDuplicateProposalCount: number;
          findingCount: number;
          findings: Array<{ findingKey: string; evidence: Array<{ kind: string }> }>;
        } | null;
      };
    };

    expect(handResponse.status).toBe(200);
    expect(handBody.hand.status).toBe("active");
    expect(handBody.hand.latestRun).toMatchObject({
      status: "succeeded",
      proposalSessionId: "improvement:proposals",
      reviewedSignalCount: 6,
      generatedProposalCount: 3,
      skippedDuplicateProposalCount: 0,
      findingCount: 3
    });
    expect(handBody.hand.latestRun?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ findingKey: "fallback-spike" }),
        expect.objectContaining({ findingKey: "blocked-tool-spike" }),
        expect.objectContaining({ findingKey: "failed-hand-run" })
      ])
    );
    expect(handBody.hand.latestRun?.findings[0]?.evidence.length).toBeGreaterThan(0);
    expect(proposalSession?.toolEvents).toHaveLength(1);
    expect(proposalSession?.toolEvents[0]?.metadata).toMatchObject({
      audit: {
        toolId: "regression-watch-review",
        capability: "improvement.detect.regressions",
        policy: "scheduled-safe",
        outcome: "succeeded"
      },
      generatedProposalCount: 3,
      reviewedSignalCount: 6,
      findingCount: 3,
      proposals: expect.arrayContaining([
        expect.objectContaining({ candidateKey: "investigate-fallback-spike" }),
        expect.objectContaining({ candidateKey: "investigate-blocked-tool-spike" }),
        expect.objectContaining({ candidateKey: "stabilize-failed-hand-run" })
      ])
    });

    await worker.scheduled?.(
      {
        cron: "*/30 * * * *",
        noRetry() {},
        scheduledTime: Date.parse("2026-03-09T08:30:00.000Z"),
        type: "scheduled"
      } as ScheduledController,
      env as Env
    );

    const proposalSessionAfterReplay = await proposalRepository.getSession();
    const regressionWatchRepository = new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      "hand:regression-watch"
    );
    const regressionWatchSession = await regressionWatchRepository.getSession();

    expect(proposalSessionAfterReplay?.toolEvents).toHaveLength(1);
    expect(regressionWatchSession?.toolEvents[2]?.metadata).toMatchObject({
      generatedProposalCount: 0,
      reviewedSignalCount: 6,
      skippedDuplicateProposalCount: 3,
      findingCount: 3,
      audit: {
        toolId: "hand-run",
        policy: "scheduled-safe",
        capability: "hand.execute.scheduled",
        outcome: "succeeded"
      }
    });
  });

  it("lists bundled manifest-driven skills and surfaces secret readiness", async () => {
    const { env } = createEnv();

    const listResponse = await worker.fetch(new Request("https://aaronclaw.test/api/skills"), env as Env);
    const listBody = (await listResponse.json()) as {
      skills: Array<{
        id: string;
        readiness: string;
        memoryScope: string;
        declaredTools: string[];
        declaredToolDetails: Array<{ id: string; capability: string; policy: string }>;
        requiredSecrets: Array<{ id: string; configured: boolean }>;
      }>;
    };

    const detailResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/skills/gemini-review"),
      env as Env
    );
    const detailBody = (await detailResponse.json()) as {
      skill: {
        id: string;
        installScope: string;
        runtime: string;
        missingSecretIds: string[];
      };
    };

    expect(listResponse.status).toBe(200);
    expect(listBody.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "aarondb-research",
          readiness: "ready",
          memoryScope: "session-and-knowledge-vault",
          declaredTools: ["session-recall", "knowledge-vault"],
          declaredToolDetails: [
            expect.objectContaining({
              id: "session-recall",
              capability: "memory.read.session",
              policy: "automatic-safe"
            }),
            expect.objectContaining({
              id: "knowledge-vault",
              capability: "memory.read.knowledge-vault",
              policy: "automatic-safe"
            })
          ]
        }),
        expect.objectContaining({
          id: "gemini-review",
          readiness: "missing-secrets",
          requiredSecrets: [expect.objectContaining({ id: "gemini-api-key", configured: false })]
        }),
        expect.objectContaining({
          id: "incident-triage",
          readiness: "ready",
          memoryScope: "session-only",
          declaredTools: ["session-history", "hand-history", "audit-history", "runtime-state"],
          declaredToolDetails: expect.arrayContaining([
            expect.objectContaining({
              id: "session-history",
              capability: "diagnostics.read.session-history",
              policy: "automatic-safe"
            }),
            expect.objectContaining({
              id: "hand-history",
              capability: "diagnostics.read.hand-history",
              policy: "automatic-safe"
            }),
            expect.objectContaining({
              id: "audit-history",
              capability: "diagnostics.read.audit-history",
              policy: "automatic-safe"
            }),
            expect.objectContaining({
              id: "runtime-state",
              capability: "diagnostics.read.runtime-state",
              policy: "automatic-safe"
            })
          ])
        })
      ])
    );
    expect(detailResponse.status).toBe(200);
    expect(detailBody.skill).toMatchObject({
      id: "gemini-review",
      installScope: "bundled-local-only",
      runtime: "cloudflare-worker",
      missingSecretIds: ["gemini-api-key"]
    });
  });

  it("injects manifest-driven skill prompts and memory scope into the chat runtime", async () => {
    const { env } = createEnv({ aiMode: "success", geminiApiKey: "gemini-secret-123" });

    const created = await worker.fetch(
      new Request("https://aaronclaw.test/api/sessions", { method: "POST" }),
      env as Env
    );
    const createdBody = (await created.json()) as { sessionId: string };

    const chatted = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Review the active model path using the local skill manifest.",
          skillId: "gemini-review"
        })
      }),
      env as Env
    );
    const chattedBody = (await chatted.json()) as {
      session: {
        messages: Array<{
          metadata: Record<string, unknown> | null;
        }>;
      };
    };

    const lastRun = (env.AI as FakeAiBinding).getLastRun();

    expect(chatted.status).toBe(201);
    expect(chattedBody.session.messages[0]?.metadata).toMatchObject({
      skillId: "gemini-review",
      skillMemoryScope: "session-only"
    });
    expect(chattedBody.session.messages[1]?.metadata).toMatchObject({
      skillId: "gemini-review",
      skillDeclaredTools: ["session-recall", "model-selection"],
      skillDeclaredToolPolicies: expect.arrayContaining([
        expect.objectContaining({
          id: "session-recall",
          capability: "memory.read.session",
          policy: "automatic-safe"
        }),
        expect.objectContaining({
          id: "model-selection",
          capability: "assistant.route.select",
          policy: "automatic-safe"
        })
      ]),
      knowledgeVaultMatchCount: 0,
      knowledgeVaultSource: "skill-disabled",
      toolAuditTrail: expect.arrayContaining([
        expect.objectContaining({
          toolId: "session-recall",
          capability: "memory.read.session",
          policy: "automatic-safe",
          outcome: "succeeded"
        }),
        expect.objectContaining({
          toolId: "knowledge-vault",
          capability: "memory.read.knowledge-vault",
          policy: "automatic-safe",
          outcome: "blocked"
        }),
        expect.objectContaining({
          toolId: "model-selection",
          capability: "assistant.route.select",
          policy: "automatic-safe",
          outcome: "succeeded"
        })
      ])
    });
    expect(lastRun?.input.messages.some((message) => message.content.includes("Manifest-driven skill runtime"))).toBe(
      true
    );
    expect(lastRun?.input.messages.some((message) => message.content.includes("Memory scope: session recall only."))).toBe(
      true
    );
  });

  it("injects bounded incident-triage diagnostics from session, hand, audit, and runtime state", async () => {
    const { env } = createEnv({ aiMode: "success", appAuthToken: "letmein" });

    const created = await worker.fetch(
      new Request("https://aaronclaw.test/api/sessions", {
        method: "POST",
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );
    const createdBody = (await created.json()) as { sessionId: string };

    await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/messages`, {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          role: "assistant",
          content: "The previous request fell back after knowledge-vault access was blocked.",
          metadata: {
            fallbackReason: "ai-error",
            toolAuditTrail: [
              {
                toolId: "knowledge-vault",
                capability: "memory.read.knowledge-vault",
                policy: "automatic-safe",
                outcome: "blocked",
                detail: "Knowledge vault was blocked on the earlier turn.",
                timestamp: "2026-03-10T09:00:00.000Z"
              }
            ]
          }
        })
      }),
      env as Env
    );
    await worker.fetch(
      new Request("https://aaronclaw.test/api/hands/scheduled-maintenance/activate", {
        method: "POST",
        headers: { authorization: "Bearer letmein" }
      }),
      env as Env
    );

    const chatted = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/chat`, {
        method: "POST",
        headers: {
          authorization: "Bearer letmein",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          content: "Diagnose why the assistant degraded and what I should check next.",
          skillId: "incident-triage"
        })
      }),
      env as Env
    );
    const chattedBody = (await chatted.json()) as {
      session: {
        messages: Array<{
          metadata: Record<string, unknown> | null;
        }>;
      };
    };
    const assistantMetadata = chattedBody.session.messages[chattedBody.session.messages.length - 1]?.metadata;
    const lastRun = (env.AI as FakeAiBinding).getLastRun();

    expect(chatted.status).toBe(201);
    expect(assistantMetadata).toMatchObject({
      skillId: "incident-triage",
      skillDeclaredTools: ["session-history", "hand-history", "audit-history", "runtime-state"],
      toolAuditTrail: expect.arrayContaining([
        expect.objectContaining({
          toolId: "session-history",
          capability: "diagnostics.read.session-history",
          outcome: "succeeded"
        }),
        expect.objectContaining({
          toolId: "hand-history",
          capability: "diagnostics.read.hand-history",
          outcome: "succeeded"
        }),
        expect.objectContaining({
          toolId: "audit-history",
          capability: "diagnostics.read.audit-history",
          outcome: "succeeded"
        }),
        expect.objectContaining({
          toolId: "runtime-state",
          capability: "diagnostics.read.runtime-state",
          outcome: "succeeded"
        })
      ])
    });
    expect(
      lastRun?.input.messages.some((message) => message.content.includes("Incident diagnostics — session history evidence:"))
    ).toBe(true);
    expect(
      lastRun?.input.messages.some((message) => message.content.includes("Incident diagnostics — hand history evidence:"))
    ).toBe(true);
    expect(lastRun?.input.messages.some((message) => message.content.includes("scheduled-maintenance"))).toBe(true);
    expect(lastRun?.input.messages.some((message) => message.content.includes("Incident diagnostics — audit evidence:"))).toBe(
      true
    );
    expect(lastRun?.input.messages.some((message) => message.content.includes("knowledge-vault"))).toBe(true);
    expect(
      lastRun?.input.messages.some((message) => message.content.includes("Incident diagnostics — runtime/provider state:"))
    ).toBe(true);
    expect(lastRun?.input.messages.some((message) => message.content.includes("activeModelId"))).toBe(true);
  });

  it("rejects a skill-gated chat request when required secrets are missing", async () => {
    const { env } = createEnv({ aiMode: "success" });

    const created = await worker.fetch(
      new Request("https://aaronclaw.test/api/sessions", { method: "POST" }),
      env as Env
    );
    const createdBody = (await created.json()) as { sessionId: string };

    const chatted = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Try the Gemini review skill without a configured key.",
          skillId: "gemini-review"
        })
      }),
      env as Env
    );
    const chattedBody = (await chatted.json()) as {
      error: string;
      skill: { id: string; missingSecretIds: string[] };
    };
    const replayed = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${createdBody.sessionId}`),
      env as Env
    );
    const replayedBody = (await replayed.json()) as {
      session: { messages: unknown[] };
    };

    expect(chatted.status).toBe(409);
    expect(chattedBody.error).toContain("missing required secrets");
    expect(chattedBody.skill).toMatchObject({
      id: "gemini-review",
      missingSecretIds: ["gemini-api-key"]
    });
    expect(replayed.status).toBe(200);
    expect(replayedBody.session.messages).toHaveLength(0);
  });

  it("keeps paused hands idle when cron fires", async () => {
    const { env, database } = createEnv();

    await seedHistoricalSession(
      database,
      "history-5",
      "Paused hands should not run scheduled maintenance automatically."
    );

    await worker.scheduled?.(
      {
        cron: "*/30 * * * *",
        noRetry() {},
        scheduledTime: Date.parse("2026-03-09T08:30:00.000Z"),
        type: "scheduled"
      } as ScheduledController,
      env as Env
    );

    const maintenanceRepository = new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      "maintenance:2026-03-09"
    );
    const maintenanceSession = await maintenanceRepository.getSession();
    const handResponse = await worker.fetch(
      new Request("https://aaronclaw.test/api/hands/scheduled-maintenance"),
      env as Env
    );
    const handBody = (await handResponse.json()) as {
      hand: { status: string; latestRun: unknown | null };
    };

    expect(maintenanceSession).toBeNull();
    expect(handResponse.status).toBe(200);
    expect(handBody.hand.status).toBe("paused");
    expect(handBody.hand.latestRun).toBeNull();
  });

  it("serves HEAD for the root and health endpoints without falling through to 404", async () => {
    const { env } = createEnv({ aiMode: "success" });

    const rootResponse = await worker.fetch(
      new Request("https://aaronclaw.test/", { method: "HEAD" }),
      env as Env
    );
    const healthResponse = await worker.fetch(
      new Request("https://aaronclaw.test/health", { method: "HEAD" }),
      env as Env
    );

    expect(rootResponse.status).toBe(200);
    expect(rootResponse.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    await expect(rootResponse.text()).resolves.toBe("");

    expect(healthResponse.status).toBe(200);
    expect(healthResponse.headers.get("content-type")).toBe(
      "application/json; charset=UTF-8"
    );
    await expect(healthResponse.text()).resolves.toBe("");
  });

  it("routes Telegram webhook text messages through the existing chat flow and replies via Telegram", async () => {
    const { env } = createEnv({
      aiMode: "success",
      telegramBotToken: "telegram-test-token",
      telegramWebhookSecret: "telegram-secret"
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), {
        status: 200,
        headers: { "content-type": "application/json; charset=UTF-8" }
      })
    );

    const response = await worker.fetch(
      new Request("https://aaronclaw.test/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "telegram-secret"
        },
        body: JSON.stringify({
          update_id: 456,
          message: {
            message_id: 123,
            date: 1_741_552_800,
            text: "Please remember this Telegram turn.",
            chat: {
              id: 777,
              type: "private",
              username: "telegram_chat"
            },
            from: {
              id: 888,
              is_bot: false,
              username: "telegram_user",
              first_name: "Tele",
              last_name: "Gram"
            }
          }
        })
      }),
      env as Env
    );
    const body = (await response.json()) as { ok: boolean };
    const sessionId = buildTelegramSessionId({
      messageId: 123,
      date: 1_741_552_800,
      text: "Please remember this Telegram turn.",
      chat: { id: 777, type: "private", username: "telegram_chat" },
      from: {
        id: 888,
        isBot: false,
        username: "telegram_user",
        firstName: "Tele",
        lastName: "Gram"
      }
    });

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-test-token/sendMessage",
      expect.objectContaining({ method: "POST" })
    );

    const outboundPayload = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
      chat_id: number;
      text: string;
      reply_to_message_id: number;
    };

    expect(outboundPayload.chat_id).toBe(777);
    expect(outboundPayload.reply_to_message_id).toBe(123);
    expect(outboundPayload.text).toContain("AI reply");

    const replayed = await worker.fetch(
      new Request(`https://aaronclaw.test/api/sessions/${sessionId}`, { method: "GET" }),
      env as Env
    );
    const replayedBody = (await replayed.json()) as {
      session: {
        messages: Array<{
          role: string;
          content: string;
          metadata: Record<string, unknown> | null;
        }>;
      };
    };

    expect(replayed.status).toBe(200);
    expect(replayedBody.session.messages).toHaveLength(2);
    expect(replayedBody.session.messages[0]).toMatchObject({
      role: "user",
      content: "Please remember this Telegram turn.",
      metadata: expect.objectContaining({
        channel: "telegram",
        telegramChatId: 777,
        telegramUserId: 888,
        telegramMessageId: 123,
        telegramUpdateId: 456
      })
    });
  });

  it("keeps Telegram webhook delivery working when Workers AI falls back", async () => {
    const { env } = createEnv({
      aiMode: "throw",
      telegramBotToken: "telegram-test-token",
      telegramWebhookSecret: "telegram-secret"
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 1001 } }), {
        status: 200,
        headers: { "content-type": "application/json; charset=UTF-8" }
      })
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await worker.fetch(
      new Request("https://aaronclaw.test/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "telegram-secret"
        },
        body: JSON.stringify({
          update_id: 457,
          message: {
            message_id: 124,
            date: 1_741_552_801,
            text: "Please keep replying even if Workers AI is down.",
            chat: {
              id: 778,
              type: "private",
              username: "telegram_chat_fallback"
            },
            from: {
              id: 889,
              is_bot: false,
              username: "telegram_user_fallback",
              first_name: "Fallback",
              last_name: "User"
            }
          }
        })
      }),
      env as Env
    );
    const body = (await response.json()) as { ok: boolean };
    const outboundPayload = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
      text: string;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(outboundPayload.text).toContain("built-in deterministic fallback reply");
    expect(outboundPayload.text).toContain("Workers AI (@cf/meta/test-model) failed for this request");
  });

  it("rejects Telegram webhook requests when the configured webhook secret is missing", async () => {
    const { env } = createEnv({
      telegramBotToken: "telegram-test-token",
      telegramWebhookSecret: "telegram-secret"
    });

    const response = await worker.fetch(
      new Request("https://aaronclaw.test/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ update_id: 1 })
      }),
      env as Env
    );

    expect(response.status).toBe(401);
  });

  it("ignores unsupported Telegram updates without touching the session runtime", async () => {
    const { env } = createEnv({ telegramBotToken: "telegram-test-token" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await worker.fetch(
      new Request("https://aaronclaw.test/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          update_id: 123,
          callback_query: {
            id: "callback-1"
          }
        })
      }),
      env as Env
    );
    const body = (await response.json()) as { ignored: string; ok: boolean };

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, ignored: "unsupported-update" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("reflection engine", () => {
  it("stores a reflection artifact for a compatible AaronDB session projection", async () => {
    const { env } = createEnv();
    const repository = new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      "session-reflect"
    );

    await repository.createSession("2026-03-09T00:00:00.000Z");
    await repository.appendMessage({
      timestamp: "2026-03-09T00:00:01.000Z",
      role: "user",
      content: "Because the replay path uses D1 facts, please verify the proof steps."
    });
    const session = await repository.appendToolEvent({
      timestamp: "2026-03-09T00:00:02.000Z",
      toolName: "search",
      summary: "Evidence gathered from the fact log inspection."
    });

    const reflection = await reflectSession({
      env,
      sessionId: "session-reflect",
      session,
      timestamp: "2026-03-09T00:00:03.000Z"
    });
    const reflectionSession = await new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      "reflection:session-reflect"
    ).getSession();

    expect(reflection.persisted).toBe(true);
    expect(reflection.reflectionSessionId).toBe("reflection:session-reflect");
    expect(reflection.summary).toContain("Reasoning/proof signals");
    expect(reflection.improvementSignalCount).toBe(1);
    expect(reflection.improvementCandidateCount).toBe(1);
    expect(reflectionSession?.toolEvents[0]?.metadata).toMatchObject({
      improvementSignals: [
        expect.objectContaining({
          signalKey: "evidence-backed-reasoning-present",
          verification: expect.objectContaining({ status: "verified" })
        })
      ],
      improvementCandidates: [
        expect.objectContaining({
          candidateKey: "promote-evidence-backed-pattern",
          derivedFromSignalKeys: ["evidence-backed-reasoning-present"]
        })
      ]
    });
  });

  it("maps fallback and degraded tool-audit metadata into structured improvement artifacts", async () => {
    const { env } = createEnv();
    const repository = new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      "session-fallback"
    );

    await repository.createSession("2026-03-09T00:00:00.000Z");
    await repository.appendMessage({
      timestamp: "2026-03-09T00:00:01.000Z",
      role: "user",
      content: "Please check why the route keeps falling back."
    });
    const session = await repository.appendMessage({
      timestamp: "2026-03-09T00:00:02.000Z",
      role: "assistant",
      content: "I used the fallback path for this request.",
      metadata: {
        fallbackReason: "ai-error",
        toolAuditTrail: [
          {
            toolId: "knowledge-vault",
            outcome: "blocked",
            detail: "Skill default does not declare knowledge-vault, so cross-session recall was skipped."
          }
        ]
      }
    });

    const reflection = await reflectSession({
      env,
      sessionId: "session-fallback",
      session,
      timestamp: "2026-03-09T00:00:03.000Z"
    });
    const reflectionSession = await new AaronDbEdgeSessionRepository(
      env.AARONDB as D1Database,
      "reflection:session-fallback"
    ).getSession();

    expect(reflection.persisted).toBe(true);
    expect(reflection.improvementSignalCount).toBe(2);
    expect(reflection.improvementCandidateCount).toBe(2);
    expect(reflectionSession?.toolEvents[0]?.metadata).toMatchObject({
      improvementSignals: expect.arrayContaining([
        expect.objectContaining({
          signalKey: "degraded-tool-audit",
          evidence: expect.arrayContaining([
            expect.objectContaining({ kind: "audit" })
          ])
        }),
        expect.objectContaining({
          signalKey: "assistant-fallback-observed",
          evidence: expect.arrayContaining([
            expect.objectContaining({ summary: "fallbackReason=ai-error." })
          ])
        })
      ]),
      improvementCandidates: expect.arrayContaining([
        expect.objectContaining({ candidateKey: "stabilize-degraded-tool-path" }),
        expect.objectContaining({ candidateKey: "track-and-reduce-fallback-frequency" })
      ])
    });
  });
});