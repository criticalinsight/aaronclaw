import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { SessionRuntime } from "../src/index";
import { queryKnowledgeVault } from "../src/knowledge-vault";
import { reflectSession } from "../src/reflection-engine";
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
    if (!sql.includes("FROM aarondb_facts")) {
      throw new Error(`Unsupported query: ${sql}`);
    }

    const [sessionId] = params as [string];
    const excludeSession = sql.includes("session_id != ?");

    return this.rows
      .filter((row) => (excludeSession ? row.session_id !== sessionId : row.session_id === sessionId))
      .sort((left, right) => left.tx - right.tx || left.tx_index - right.tx_index) as T[];
  }

  execute(sql: string, params: unknown[]) {
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

  async run(model: string, input: { messages: Array<{ role: string; content: string }> }) {
    this.runs.push({ model, input });

    if (this.mode === "throw") {
      throw new Error("Workers AI unavailable");
    }

    if (this.mode === "empty") {
      return { response: "" };
    }

    const latestUserMessage = [...input.messages].reverse().find((message) => message.role === "user");

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
  telegramBotToken?: string;
  telegramWebhookSecret?: string;
  vectorizeMode?: "success" | "throw";
} = {}) {
  const database = new FakeD1Database();
  const env = {
    AARONDB: database as unknown as D1Database,
    AI: options.aiMode ? new FakeAiBinding(options.aiMode) : undefined,
    AI_MODEL: "@cf/meta/test-model",
    APP_AUTH_TOKEN: options.appAuthToken,
    TELEGRAM_BOT_TOKEN: options.telegramBotToken,
    TELEGRAM_WEBHOOK_SECRET: options.telegramWebhookSecret,
    VECTOR_INDEX: options.vectorizeMode
      ? (new FakeVectorizeIndex(options.vectorizeMode) as unknown as VectorizeIndex)
      : undefined
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
      assistantBindingStatus: string;
      assistantFallbackBehavior: string;
    };

    expect(response.status).toBe(200);
    expect(body.authMode).toBe("bearer-token");
    expect(body.authBoundary).toContain("Landing page stays public");
    expect(body.assistantRuntime).toBe("workers-ai");
    expect(body.assistantBindingStatus).toBe("configured");
    expect(body.assistantFallbackBehavior).toContain("logs the reason");
  });

  it("runs scheduled maintenance and persists a morning briefing session", async () => {
    const { env, database } = createEnv();

    await seedHistoricalSession(
      database,
      "history-4",
      "Morning maintenance should review recent reasoning evidence for AaronDB sessions."
    );
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

    expect(briefingSession?.toolEvents[0]).toMatchObject({
      toolName: "morning-briefing"
    });
    expect(briefingSession?.toolEvents[0]?.summary).toContain("Morning briefing");
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

    expect(reflection.persisted).toBe(true);
    expect(reflection.reflectionSessionId).toBe("reflection:session-reflect");
    expect(reflection.summary).toContain("Reasoning/proof signals");
  });
});