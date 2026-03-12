import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const placeholderId = "00000000-0000-0000-0000-000000000000";
const configPath = resolve(process.cwd(), "wrangler.jsonc");
const outputDir = resolve(process.cwd(), ".wrangler", "deploy");
const outputPath = resolve(outputDir, "wrangler.jsonc");
const migrationsSourceDir = resolve(process.cwd(), "migrations");
const migrationsOutputDir = resolve(outputDir, "migrations");

const databaseId = process.env.AARONCLAW_D1_DATABASE_ID?.trim();
const databaseName = process.env.AARONCLAW_D1_DATABASE_NAME?.trim();
const includeVectorize = /^(1|true)$/i.test(
  process.env.AARONCLAW_DEPLOY_WITH_VECTORIZE?.trim() ?? ""
);

if (!databaseId) {
  fail(
    "Missing AARONCLAW_D1_DATABASE_ID. Run `wrangler d1 create aaronclaw-aarondb` and export the returned database UUID before deploying."
  );
}

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(databaseId)) {
  fail("AARONCLAW_D1_DATABASE_ID must be a UUID.");
}

let configText = readFileSync(configPath, "utf8");

if (!configText.includes(placeholderId)) {
  fail(`Expected placeholder database_id ${placeholderId} in wrangler.jsonc.`);
}

configText = configText.replace(placeholderId, databaseId);
configText = configText.replace(
  /"\$schema"\s*:\s*"node_modules\/wrangler\/config-schema\.json"/,
  '"$schema": "../../node_modules/wrangler/config-schema.json"'
);
configText = configText.replace(
  /"main"\s*:\s*"src\/index\.ts"/,
  '"main": "../../src/index.ts"'
);

if (databaseName) {
  configText = configText.replace(
    /"database_name"\s*:\s*"[^"]+"/,
    `"database_name": "${databaseName.replaceAll('"', "")}"`
  );
}

if (!includeVectorize) {
  configText = configText.replace(
    /\n\s*"vectorize"\s*:\s*\[\s*\{\s*"binding"\s*:\s*"VECTOR_INDEX"\s*,\s*"index_name"\s*:\s*"[^"]+"\s*\}\s*\],?/m,
    ""
  );
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputPath, configText);

if (existsSync(migrationsSourceDir)) {
  rmSync(migrationsOutputDir, { recursive: true, force: true });
  cpSync(migrationsSourceDir, migrationsOutputDir, { recursive: true });
}

console.log(`Generated deploy config at ${outputPath}`);
console.log(`- database_id: ${databaseId}`);
console.log(
  `- database_name: ${databaseName || "aaronclaw-aarondb"}`
);
console.log(
  `- migrations: ${existsSync(migrationsSourceDir) ? "copied" : "not present"}`
);
console.log(
  `- vectorize: ${includeVectorize ? "included" : "omitted (D1 compatibility fallback)"}`
);

function fail(message) {
  console.error(`AaronClaw deploy config generation failed: ${message}`);
  process.exit(1);
}