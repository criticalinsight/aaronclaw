import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const rootConfigPath = new URL("../wrangler.jsonc", import.meta.url);
const rootMigrationsPath = new URL("../migrations", import.meta.url);
const scriptPath = fileURLToPath(new URL("../scripts/render-deploy-config.mjs", import.meta.url));
const tempDirs = [];

function runRenderDeployConfig(extraEnv = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "aaronclaw-render-"));
  tempDirs.push(cwd);
  writeFileSync(join(cwd, "wrangler.jsonc"), readFileSync(rootConfigPath, "utf8"));

  if (existsSync(rootMigrationsPath)) {
    cpSync(rootMigrationsPath, join(cwd, "migrations"), { recursive: true });
  }

  execFileSync("node", [scriptPath], {
    cwd,
    env: {
      ...process.env,
      AARONCLAW_D1_DATABASE_ID: "11111111-1111-4111-8111-111111111111",
      AARONCLAW_DEPLOY_WITH_VECTORIZE: "",
      ...extraEnv
    }
  });

  return readFileSync(join(cwd, ".wrangler", "deploy", "wrangler.jsonc"), "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("render-deploy-config", () => {
  it("omits the Vectorize binding by default so deploys can use the D1 fallback path", () => {
    const rendered = runRenderDeployConfig();

    expect(rendered).not.toContain('"vectorize"');
    expect(rendered).toContain('"database_id": "11111111-1111-4111-8111-111111111111"');
  });

  it("keeps the Vectorize binding when explicitly requested", () => {
    const rendered = runRenderDeployConfig({ AARONCLAW_DEPLOY_WITH_VECTORIZE: "1" });

    expect(rendered).toContain('"vectorize"');
    expect(rendered).toContain('"binding": "VECTOR_INDEX"');
  });

  it("copies checked-in migrations beside the generated deploy config", () => {
    const cwd = mkdtempSync(join(tmpdir(), "aaronclaw-render-migrations-"));
    tempDirs.push(cwd);
    writeFileSync(join(cwd, "wrangler.jsonc"), readFileSync(rootConfigPath, "utf8"));
    cpSync(rootMigrationsPath, join(cwd, "migrations"), { recursive: true });

    execFileSync("node", [scriptPath], {
      cwd,
      env: {
        ...process.env,
        AARONCLAW_D1_DATABASE_ID: "11111111-1111-4111-8111-111111111111"
      }
    });

    expect(readFileSync(join(cwd, ".wrangler", "deploy", "migrations", "0001_aarondb_edge.sql"), "utf8")).toContain(
      "CREATE TABLE"
    );
  });
});