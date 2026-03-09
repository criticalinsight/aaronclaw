import { describe, expect, it } from "vitest";
import worker, { SessionRuntime } from "../src/index";
import { AaronDbEdgeSessionRepository } from "../src/session-state";

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

    return this.rows
      .filter((row) => row.session_id === sessionId)
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
  constructor(private readonly mode: "success" | "throw" = "success") {}

  async run(_model: string, input: { messages: Array<{ role: string; content: string }> }) {
    if (this.mode === "throw") {
      throw new Error("Workers AI unavailable");
    }

    const latestUserMessage = [...input.messages].reverse().find((message) => message.role === "user");

    return {
      response: `AI reply: ${latestUserMessage?.content ?? "(no prompt)"}`
    };
  }
}

function createEnv(options: { appAuthToken?: string; aiMode?: "success" | "throw" } = {}) {
  const database = new FakeD1Database();
  const env = {
    AARONDB: database as unknown as D1Database,
    AI: options.aiMode ? new FakeAiBinding(options.aiMode) : undefined,
    AI_MODEL: "@cf/meta/test-model",
    APP_AUTH_TOKEN: options.appAuthToken
  } as Env & {
    SESSION_RUNTIME: DurableObjectNamespace & FakeSessionRuntimeNamespace;
  };

  env.SESSION_RUNTIME = new FakeSessionRuntimeNamespace(
    env as Env
  ) as unknown as DurableObjectNamespace & FakeSessionRuntimeNamespace;
  return { env, database };
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
      content: "Remember that replay comes from the D1 fact log."
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

    const asOf = await rehydrated.getSession({ asOf: 2 });
    expect(asOf?.events).toHaveLength(1);

    const recall = await rehydrated.recall({ query: "How does D1 replay work?" });
    expect(recall[0]?.preview).toContain("D1 fact log");
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
      };
    };

    expect(chatted.status).toBe(201);
    expect(chattedBody.assistant.source).toBe("fallback");
    expect(chattedBody.assistant.model).toBe("@cf/meta/test-model");
    expect(chattedBody.assistant.fallbackReason).toBe("ai-unavailable");
    expect(chattedBody.assistant.content).toContain("was unavailable for this request");
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
      assistantFallbackBehavior: string;
    };

    expect(response.status).toBe(200);
    expect(body.authMode).toBe("bearer-token");
    expect(body.authBoundary).toContain("Landing page stays public");
    expect(body.assistantRuntime).toBe("workers-ai");
    expect(body.assistantFallbackBehavior).toContain("deterministic fallback is used only");
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
});