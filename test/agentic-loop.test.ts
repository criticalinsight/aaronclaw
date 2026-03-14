import { describe, it, expect, vi } from "vitest";
import { SessionRuntime } from "../src/session-runtime";
import { AaronDbEdgeSessionRepository } from "../src/session-state";

type Env = any;

// Mocking dependencies
vi.mock("../src/hands-runtime", () => ({
  triggerBundledHandRunManual: vi.fn(),
  listBundledHands: vi.fn()
}));

vi.mock("../src/knowledge-vault", () => ({
  queryKnowledgeVault: vi.fn(() => Promise.resolve({ matches: [], source: "mock" }))
}));

describe("SessionRuntime Agentic Loop", () => {
  it("should execute a tool call and re-invoke the assistant", async () => {
    const { triggerBundledHandRunManual } = await import("../src/hands-runtime");

    const mockAiRun = vi.fn();
    mockAiRun
      // 1. First reply contains a tool call
      .mockResolvedValueOnce({
        response: "I'll create that website for you.",
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "hand-run-manual",
              arguments: JSON.stringify({ handId: "website-factory", input: { prompt: "dark mode photographer" } })
            }
          }
        ]
      })
      // 2. Second reply (after tool execution) contains the final text
      .mockResolvedValueOnce({
        response: "Website creation has been triggered.",
        tool_calls: []
      });

    (triggerBundledHandRunManual as any).mockResolvedValue({
      status: "triggered",
      handId: "website-factory"
    });

    const storedFacts: any[] = [];
    const mockDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        let boundArgs: any[] = [];
        const stmt: any = {
          bind: vi.fn().mockImplementation((...args: any[]) => {
            boundArgs = args;
            return stmt;
          }),
          run: vi.fn().mockImplementation(() => {
            if (sql.includes("INSERT INTO")) {
              storedFacts.push({
                session_id: boundArgs[0],
                entity: boundArgs[1],
                attribute: boundArgs[2],
                value_json: boundArgs[3],
                tx: boundArgs[4],
                tx_index: boundArgs[5],
                occurred_at: boundArgs[6],
                operation: boundArgs[7]
              });
            }
            return Promise.resolve({ success: true });
          }),
          all: vi.fn().mockImplementation(() => {
            if (sql.includes("SELECT") && (sql.includes("facts") || sql.includes("aarondb_facts"))) {
              return Promise.resolve({ results: storedFacts });
            }
            return Promise.resolve({ results: [] });
          }),
          first: vi.fn().mockResolvedValue(null)
        };
        return stmt;
      }),
      batch: vi.fn().mockImplementation((statements: any[]) => {
        return Promise.all(statements.map(s => s.run()));
      })
    };

    const env = {
      AARONDB: mockDb,
      AI: {
        run: mockAiRun
      } as any,
      GEMINI_API_KEY: "test-key"
    } as unknown as Env;

    const mockState = {
      id: { toString: () => "test-id" },
      storage: {
        get: vi.fn(),
        put: vi.fn()
      }
    } as any;

    const runtime = new SessionRuntime(mockState, env);
    const sessionId = "test-session";

    // Initialize session first
    await runtime.fetch(
      new Request(`https://aaronclaw.test/init?sessionId=${sessionId}`, {
        method: "POST"
      })
    );

    let response;
    try {
      response = await runtime.fetch(
        new Request(`https://aaronclaw.test/chat?sessionId=${sessionId}`, {
          method: "POST",
          body: JSON.stringify({ content: "Make a website" })
        })
      );
    } catch (e: any) {
      console.error("fetch CRASH:", e.stack || e);
      throw e;
    }

    if (response.status !== 201) {
      const errorBody = await response.json();
      console.error("Test failed with status", response.status, JSON.stringify(errorBody, null, 2));
    }
    expect(response.status).toBe(201);
    const body: any = await response.json();

    // Verify tool execution was called
    expect(triggerBundledHandRunManual).toHaveBeenCalledWith(expect.objectContaining({
      handId: "website-factory",
      input: { prompt: "dark mode photographer" }
    }));

    // Verify AI was called twice
    expect(mockAiRun).toHaveBeenCalledTimes(2);

    // Verify messages in state
    const messages = body.session.messages;
    expect(messages).toHaveLength(4); // User, Assistant (tool call), Tool (result), Assistant (final)
    expect(messages[1].toolCalls).toBeDefined();
    expect(messages[2].role).toBe("tool");
    expect(messages[2].toolCallId).toBe("call_123");
    expect(messages[3].content).toBe("Website creation has been triggered.");
    expect(messages[3].metadata.agenticLoopCount).toBe(1);
  });
});
