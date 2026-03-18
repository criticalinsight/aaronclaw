import { afterEach, describe, it, expect, vi } from "vitest";
import { SessionRuntime } from "../src/session-runtime";
import { AaronDbEdgeSessionRepository } from "../src/session-state";

type Env = any;

// Mocking dependencies
import * as handsRuntime from "../src/hands-runtime";
import * as knowledgeVault from "../src/knowledge-vault";

describe("SessionRuntime Agentic Loop", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("should execute a tool call and re-invoke the assistant", async () => {
    vi.spyOn(knowledgeVault, "queryKnowledgeVault").mockResolvedValue({ matches: [], source: "d1-compat" });
    vi.spyOn(knowledgeVault, "expandSemanticTerms").mockResolvedValue(["mocked term"]);
    vi.spyOn(knowledgeVault, "buildSemanticVector").mockResolvedValue([0.1, 0.2, 0.3]);
    vi.spyOn(knowledgeVault, "scoreTermOverlap").mockReturnValue(0.5);
    vi.spyOn(knowledgeVault, "safeVectorScore").mockReturnValue(0.5);
    vi.spyOn(knowledgeVault, "roundScore").mockReturnValue(0.5);
    
    const mockAiRun = vi.fn().mockImplementation((model: string, input: any) => {
      if (model.includes("bge-small")) {
        return Promise.resolve({ data: [new Array(384).fill(0.1)] });
      }

      // Handle chat completion requests
      const isToolCompletion = input.messages.some((m: any) => m.role === "tool");
      if (!isToolCompletion) {
        // 1. First reply contains a tool call
        return Promise.resolve({
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
        });
      } else {
        // 2. Second reply (after tool execution) contains the final text
        return Promise.resolve({
          response: "Website creation has been triggered.",
          tool_calls: []
        });
      }
    });

    vi.spyOn(handsRuntime, "triggerBundledHandRunManual").mockResolvedValue({
      status: "active",
      id: "website-factory"
    } as any);

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
    expect(handsRuntime.triggerBundledHandRunManual).toHaveBeenCalledWith(expect.objectContaining({
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
