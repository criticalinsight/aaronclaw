import { describe, expect, it } from "vitest";
import {
  buildBootstrapStatus,
  extractSessionId,
  parseSessionRoute
} from "../src/routes";

describe("extractSessionId", () => {
  it("returns the session id for the bootstrap session route", () => {
    expect(extractSessionId("/api/sessions/session-123")).toBe("session-123");
  });

  it("rejects other route shapes", () => {
    expect(extractSessionId("/api/sessions")).toBeNull();
    expect(extractSessionId("/health")).toBeNull();
  });
});

describe("buildBootstrapStatus", () => {
  it("documents the Worker + Durable Object AaronDB baseline", () => {
    expect(
      buildBootstrapStatus({ authRequired: true, hasAiBinding: true, defaultModel: "model-x" })
    ).toMatchObject({
      baseline: "cloudflare/moltworker",
      authMode: "bearer-token",
      assistantRuntime: "workers-ai",
      authBoundary: expect.stringContaining("/api/* routes require Authorization"),
      assistantFallbackBehavior: expect.stringContaining("Workers AI is primary"),
      defaultModel: "model-x",
      memorySource: "aarondb-edge",
      excludedRuntime: "cloudflare sandbox containers"
    });
  });

  it("describes the unauthenticated fallback-only personal mode", () => {
    expect(buildBootstrapStatus({ authRequired: false, hasAiBinding: false })).toMatchObject({
      authMode: "none",
      authBoundary: expect.stringContaining("effectively open"),
      assistantRuntime: "deterministic-fallback",
      assistantFallbackBehavior: expect.stringContaining("No AI binding is configured")
    });
  });
});

describe("parseSessionRoute", () => {
  it("parses nested AaronDB-backed session actions", () => {
    expect(parseSessionRoute("/api/sessions/session-123/messages")).toEqual({
      sessionId: "session-123",
      action: "messages"
    });

    expect(parseSessionRoute("/api/sessions/session-123/chat")).toEqual({
      sessionId: "session-123",
      action: "chat"
    });

    expect(parseSessionRoute("/api/sessions/session-123/recall")).toEqual({
      sessionId: "session-123",
      action: "recall"
    });
  });
});