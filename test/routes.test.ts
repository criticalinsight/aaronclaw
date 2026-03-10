import { describe, expect, it } from "vitest";
import {
  buildBootstrapStatus,
  extractSessionId,
  parseHandRoute,
  parseSkillRoute,
  parseSessionRoute,
  renderLandingPage
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
      buildBootstrapStatus({
        authRequired: true,
        hasAiBinding: true,
        defaultProvider: "gemini",
        defaultModel: "gemini-model",
        activeProvider: "workers-ai",
        activeModel: "workers-model",
        selectionFallbackReason: "requested-model-unavailable"
      })
    ).toMatchObject({
      baseline: "cloudflare/moltworker",
      runtimeSubstrate: "criticalinsight/aarondb-edge",
      runtimeSubstrateStrategy: "vendored-runtime-slice",
      authMode: "bearer-token",
      assistantRuntime: "gemini",
      assistantBindingStatus: "configured",
      skillRuntime: "manifest-driven",
      skillInstallScope: "bundled-local-only",
      toolPolicyRuntime: "capability-gated",
      toolAuditHistory: "structured-session-and-hand-history",
      authBoundary: expect.stringContaining("/api/* routes require Authorization"),
      assistantFallbackBehavior: expect.stringContaining("Gemini remains the default operator-facing model path"),
      defaultModel: "gemini-model",
      activeAssistantRuntime: "workers-ai",
      activeModel: "workers-model",
      selectionFallbackReason: "requested-model-unavailable",
      operatorRoutes: expect.arrayContaining([
        "GET /api/model",
        "POST /api/model",
        "GET /api/key",
        "POST /api/key",
        "GET /api/skills",
        "GET /api/skills/:id",
        "GET /api/hands",
        "GET /api/hands/:id",
        "POST /api/hands/:id/activate",
        "POST /api/hands/:id/pause"
      ]),
      memorySource: "aarondb-edge",
      runtimeSubstrateBindings: expect.arrayContaining([
        expect.objectContaining({ upstream: "AARONDB_STATE", current: "SESSION_RUNTIME" }),
        expect.objectContaining({ upstream: "DB", current: "AARONDB" })
      ]),
      excludedRuntime: "cloudflare sandbox containers"
    });
  });

  it("describes the unauthenticated fallback-only personal mode", () => {
    expect(buildBootstrapStatus({ authRequired: false, hasAiBinding: false })).toMatchObject({
      authMode: "none",
      authBoundary: expect.stringContaining("effectively open"),
      assistantRuntime: "deterministic-fallback",
      activeAssistantRuntime: "deterministic-fallback",
      assistantBindingStatus: "missing",
      assistantFallbackBehavior: expect.stringContaining("No selectable model path is currently available")
    });
  });

  it("renders the existing landing page with protected operator controls for hands and skills", () => {
    const html = renderLandingPage({ authRequired: true, defaultProvider: "gemini" });

    expect(html).toContain("Operator controls");
    expect(html).toContain("Refresh operator data");
    expect(html).toContain("/api/hands");
    expect(html).toContain("/api/skills");
    expect(html).toContain("Recent audit");
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

describe("parseHandRoute", () => {
  it("parses bundled hand list, detail, and lifecycle routes", () => {
    expect(parseHandRoute("/api/hands")).toEqual({
      handId: null,
      action: "list"
    });

    expect(parseHandRoute("/api/hands/scheduled-maintenance")).toEqual({
      handId: "scheduled-maintenance",
      action: "detail"
    });

    expect(parseHandRoute("/api/hands/scheduled-maintenance/activate")).toEqual({
      handId: "scheduled-maintenance",
      action: "activate"
    });

    expect(parseHandRoute("/api/hands/scheduled-maintenance/pause")).toEqual({
      handId: "scheduled-maintenance",
      action: "pause"
    });
  });
});

describe("parseSkillRoute", () => {
  it("parses bundled skill list and detail routes", () => {
    expect(parseSkillRoute("/api/skills")).toEqual({
      skillId: null,
      action: "list"
    });

    expect(parseSkillRoute("/api/skills/aarondb-research")).toEqual({
      skillId: "aarondb-research",
      action: "detail"
    });

    expect(parseSkillRoute("/api/skills/aarondb-research/activate")).toBeNull();
  });
});