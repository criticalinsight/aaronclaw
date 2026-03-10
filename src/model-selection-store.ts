const SETTINGS_SESSION_ID = "__aaronclaw:settings__";
const MODEL_SELECTION_ENTITY = "settings:model-selection";
const MODEL_SELECTION_ATTRIBUTE = "activeModelId";

const SELECT_MODEL_SELECTION_SQL = `
  SELECT value_json
  FROM aarondb_facts
  WHERE session_id = ?
    AND entity = ?
    AND attribute = ?
  ORDER BY tx DESC, tx_index DESC
  LIMIT 1
`;

const SELECT_LATEST_SETTINGS_TX_SQL = `
  SELECT tx
  FROM aarondb_facts
  WHERE session_id = ?
  ORDER BY tx DESC, tx_index DESC
  LIMIT 1
`;

const INSERT_MODEL_SELECTION_SQL = `
  INSERT INTO aarondb_facts (
    session_id,
    entity,
    attribute,
    value_json,
    tx,
    tx_index,
    occurred_at,
    operation
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

export async function readPersistedModelSelection(database: D1Database): Promise<string | null> {
  const result = await database
    .prepare(SELECT_MODEL_SELECTION_SQL)
    .bind(SETTINGS_SESSION_ID, MODEL_SELECTION_ENTITY, MODEL_SELECTION_ATTRIBUTE)
    .all<{ value_json: string }>();

  return parsePersistedModelSelection(result.results[0]?.value_json);
}

export async function setPersistedModelSelection(
  database: D1Database,
  modelId: string
): Promise<string> {
  const normalizedModelId = modelId.trim();

  if (!normalizedModelId) {
    throw new Error("modelId must not be empty");
  }

  const latestTxResult = await database
    .prepare(SELECT_LATEST_SETTINGS_TX_SQL)
    .bind(SETTINGS_SESSION_ID)
    .all<{ tx: number }>();
  const latestTx = Number(latestTxResult.results[0]?.tx ?? 0);
  const timestamp = new Date().toISOString();
  const tx = Math.max(Date.now(), latestTx + 1);

  await database
    .prepare(INSERT_MODEL_SELECTION_SQL)
    .bind(
      SETTINGS_SESSION_ID,
      MODEL_SELECTION_ENTITY,
      MODEL_SELECTION_ATTRIBUTE,
      JSON.stringify(normalizedModelId),
      tx,
      0,
      timestamp,
      "assert"
    )
    .run();

  return normalizedModelId;
}

function parsePersistedModelSelection(valueJson: string | undefined): string | null {
  if (!valueJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(valueJson);
    return typeof parsed === "string" && parsed.trim().length > 0 ? parsed.trim() : null;
  } catch {
    return null;
  }
}