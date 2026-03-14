import { describe, expect, it } from "vitest";
import { AccessPolicyDSL, evaluateDemiurgeAccess } from "../src/demiurge-engine";

describe("Demiurge Engine (Phase 16)", () => {
  const policy: AccessPolicyDSL = {
    version: "1.0",
    defaultAction: "deny",
    rules: [
      {
        pathPattern: "/public/*",
        allowRoles: [],
        allowUnauthenticated: true,
      },
      {
        pathPattern: "/api/admin/*",
        allowRoles: ["admin"],
      },
      {
        pathPattern: "/api/*",
        allowRoles: ["user", "admin"],
        denyRoles: ["guest"],
      },
    ],
  };

  it("allows unauthenticated access to public routes", () => {
    expect(evaluateDemiurgeAccess(policy, "/public/styles.css")).toBe(true);
  });

  it("denies unauthenticated access to protected routes", () => {
    expect(evaluateDemiurgeAccess(policy, "/api/users")).toBe(false);
  });

  it("allows role-based access", () => {
    expect(evaluateDemiurgeAccess(policy, "/api/dashboard", "user")).toBe(true);
    expect(evaluateDemiurgeAccess(policy, "/api/dashboard", "admin")).toBe(true);
  });

  it("respects denyRoles", () => {
    expect(evaluateDemiurgeAccess(policy, "/api/reports", "guest")).toBe(false);
  });

  it("enforces stricter path patterns over broader ones if ordered first (or strictly matches admin)", () => {
    expect(evaluateDemiurgeAccess(policy, "/api/admin/settings", "admin")).toBe(true);
    // user role should be denied because the /api/admin/* rule is evaluated first and doesn't explicitly allow 'user'.
    expect(evaluateDemiurgeAccess(policy, "/api/admin/settings", "user")).toBe(false);
  });
  
  it("defaults to defaultAction when no rules match", () => {
      expect(evaluateDemiurgeAccess(policy, "/unknown/path", "admin")).toBe(false);
  });
});
