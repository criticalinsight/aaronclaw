import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflowPath = fileURLToPath(new URL("../.github/workflows/deploy-on-push.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

describe("deploy-on-push workflow", () => {
  it("triggers on pushes to the deployment branch", () => {
    expect(workflow).toMatch(/on:\s*\n\s+push:\s*\n\s+branches:\s*\n\s+- plan-cloudflare-openclaw/);
  });

  it("validates before deploying", () => {
    expect(workflow).toContain("validate:");
    expect(workflow).toContain("deploy:");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("needs: validate");
    expect(workflow.indexOf("validate:")).toBeLessThan(workflow.indexOf("deploy:"));
    expect(workflow).toContain("npm run validate:config");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("npm run deploy:dry-run");
  });

  it("deploys through the existing Wrangler path with explicit safety checks", () => {
    expect(workflow).toContain("CLOUDFLARE_API_TOKEN");
    expect(workflow).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(workflow).toContain("AARONCLAW_D1_DATABASE_ID");
    expect(workflow).toContain("Missing required GitHub environment secret");
    expect(workflow).toContain("wrangler d1 migrations apply");
    expect(workflow).toContain("npm run deploy");
    expect(workflow).toContain("concurrency:");
  });
});