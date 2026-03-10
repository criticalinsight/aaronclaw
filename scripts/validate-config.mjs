import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const configPath = resolve(process.cwd(), "wrangler.jsonc");
const configText = readFileSync(configPath, "utf8");

const errors = [];

assertMatch(/"name"\s*:\s*"aaronclaw"/, 'Missing Worker name "aaronclaw".');
assertMatch(/"main"\s*:\s*"src\/index\.ts"/, 'Missing Worker entrypoint "src/index.ts".');
assertMatch(/"name"\s*:\s*"SESSION_RUNTIME"/, 'Missing Durable Object binding "SESSION_RUNTIME".');
assertMatch(/"binding"\s*:\s*"AARONDB"/, 'Missing D1 binding "AARONDB".');
assertMatch(/"binding"\s*:\s*"VECTOR_INDEX"/, 'Missing Vectorize binding "VECTOR_INDEX".');
assertMatch(/"index_name"\s*:\s*"aaronclaw-knowledge-vault"/, 'Missing Vectorize index_name for the knowledge vault.');
assertMatch(/"triggers"\s*:\s*\{/, 'Missing scheduled trigger configuration.');
assertMatch(/"\*\/30 \* \* \* \*"/, 'Missing scheduled maintenance cron trigger.');
assertMatch(/"0 8 \* \* \*"/, 'Missing morning briefing cron trigger.');

const previewDatabaseId = matchValue("preview_database_id");
if (!previewDatabaseId) {
  errors.push('Missing "preview_database_id" for local D1 development.');
}

if (previewDatabaseId === "00000000-0000-0000-0000-000000000000") {
  errors.push('preview_database_id should be a local alias such as "aaronclaw-local", not the all-zero placeholder.');
}

if (errors.length > 0) {
  console.error("AaronClaw config validation failed:\n");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

const remoteDatabaseId = matchValue("database_id");
const remoteStatus =
  remoteDatabaseId === "00000000-0000-0000-0000-000000000000"
    ? "placeholder (expected in repo; inject AARONCLAW_D1_DATABASE_ID for deploy)"
    : remoteDatabaseId;
const vectorIndexName = matchValue("index_name");
const cronEntries = [...configText.matchAll(/"(?:\*\/30 \* \* \* \*|0 8 \* \* \*)"/g)].map(
  (match) => match[0].slice(1, -1)
);

console.log("AaronClaw config validation passed.");
console.log(`- preview_database_id: ${previewDatabaseId}`);
console.log(`- database_id: ${remoteStatus}`);
console.log(`- vectorize index: ${vectorIndexName}`);
console.log(`- cron triggers: ${cronEntries.join(", ")}`);

function assertMatch(pattern, message) {
  if (!pattern.test(configText)) {
    errors.push(message);
  }
}

function matchValue(key) {
  const match = configText.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
  return match?.[1] ?? null;
}