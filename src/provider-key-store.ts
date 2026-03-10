import { DEFAULT_GEMINI_MODEL } from "./model-registry";

const SETTINGS_SESSION_ID = "__aaronclaw:settings__";
const PROVIDER_KEY_ENTITY = "settings:provider-key";
const SELECT_PROVIDER_KEY_SQL = `
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
const INSERT_PROVIDER_KEY_SQL = `
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
const GEMINI_VALIDATION_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";
const ENCRYPTION_CONTEXT = "aaronclaw:provider-key:v1";

export type ExternalProvider = "gemini";
export type ProviderKeySource = "none" | "protected-store" | "worker-secret";
export type ProviderKeyValidationStatus =
  | "not-configured"
  | "unvalidated"
  | "valid"
  | "invalid"
  | "validation-error";

export interface ProviderKeyValidationResult {
  status: ProviderKeyValidationStatus;
  checkedAt: string | null;
  detail: string | null;
  target: string;
}

export interface ProviderKeyStatus {
  provider: ExternalProvider;
  providerLabel: string;
  configured: boolean;
  source: ProviderKeySource;
  maskedKey: string | null;
  fingerprint: string | null;
  updatedAt: string | null;
  storage: "none" | "d1-encrypted-app-auth-token-derived" | "worker-secret-env";
  validation: ProviderKeyValidationResult;
}

interface StoredProviderKeyRecord {
  ciphertext: string;
  iv: string;
  maskedKey: string;
  fingerprint: string;
  updatedAt: string;
  validation: ProviderKeyValidationResult;
}

export async function readProviderKeyStatus(input: {
  env: Pick<Env, "APP_AUTH_TOKEN" | "GEMINI_API_KEY">;
  database: D1Database;
  provider: ExternalProvider;
}): Promise<ProviderKeyStatus> {
  const storedRecord = await readStoredProviderKeyRecord(input.database, input.provider);

  if (storedRecord) {
    return {
      provider: input.provider,
      providerLabel: getProviderLabel(input.provider),
      configured: true,
      source: "protected-store",
      maskedKey: storedRecord.maskedKey,
      fingerprint: storedRecord.fingerprint,
      updatedAt: storedRecord.updatedAt,
      storage: "d1-encrypted-app-auth-token-derived",
      validation: storedRecord.validation
    };
  }

  const envKey = readProviderKeyFromEnv(input.env, input.provider);
  if (envKey) {
    return {
      provider: input.provider,
      providerLabel: getProviderLabel(input.provider),
      configured: true,
      source: "worker-secret",
      maskedKey: maskSecret(envKey),
      fingerprint: await fingerprintSecret(envKey),
      updatedAt: null,
      storage: "worker-secret-env",
      validation: {
        status: "unvalidated",
        checkedAt: null,
        detail: "This provider key comes from Worker secrets and has not been validated through /api/key yet.",
        target: getProviderValidationTarget(input.provider)
      }
    };
  }

  return {
    provider: input.provider,
    providerLabel: getProviderLabel(input.provider),
    configured: false,
    source: "none",
    maskedKey: null,
    fingerprint: null,
    updatedAt: null,
    storage: "none",
    validation: {
      status: "not-configured",
      checkedAt: null,
      detail: `${getProviderLabel(input.provider)} key material is not configured.`,
      target: getProviderValidationTarget(input.provider)
    }
  };
}

export async function resolveProviderApiKey(input: {
  env: Pick<Env, "APP_AUTH_TOKEN" | "GEMINI_API_KEY">;
  database: D1Database;
  provider: ExternalProvider;
}): Promise<string | null> {
  const storedRecord = await readStoredProviderKeyRecord(input.database, input.provider);
  if (storedRecord) {
    return decryptSecret(storedRecord, input.env.APP_AUTH_TOKEN);
  }

  return readProviderKeyFromEnv(input.env, input.provider);
}

export async function setProtectedProviderKey(input: {
  env: Pick<Env, "APP_AUTH_TOKEN">;
  database: D1Database;
  provider: ExternalProvider;
  apiKey: string;
  validation: ProviderKeyValidationResult;
}): Promise<ProviderKeyStatus> {
  const normalizedApiKey = normalizeApiKey(input.apiKey);
  const record: StoredProviderKeyRecord = {
    ciphertext: "",
    iv: "",
    maskedKey: maskSecret(normalizedApiKey),
    fingerprint: await fingerprintSecret(normalizedApiKey),
    updatedAt: new Date().toISOString(),
    validation: input.validation
  };
  const encrypted = await encryptSecret(normalizedApiKey, input.env.APP_AUTH_TOKEN);
  record.ciphertext = encrypted.ciphertext;
  record.iv = encrypted.iv;
  await writeStoredProviderKeyRecord(input.database, input.provider, record);

  return {
    provider: input.provider,
    providerLabel: getProviderLabel(input.provider),
    configured: true,
    source: "protected-store",
    maskedKey: record.maskedKey,
    fingerprint: record.fingerprint,
    updatedAt: record.updatedAt,
    storage: "d1-encrypted-app-auth-token-derived",
    validation: input.validation
  };
}

export async function validateConfiguredProviderKey(input: {
  env: Pick<Env, "APP_AUTH_TOKEN" | "GEMINI_API_KEY">;
  database: D1Database;
  provider: ExternalProvider;
}): Promise<ProviderKeyStatus> {
  const apiKey = await resolveProviderApiKey(input);
  if (!apiKey) {
    return readProviderKeyStatus(input);
  }

  const validation = await validateProviderApiKey(input.provider, apiKey);
  const storedRecord = await readStoredProviderKeyRecord(input.database, input.provider);

  if (storedRecord) {
    await writeStoredProviderKeyRecord(input.database, input.provider, {
      ...storedRecord,
      validation
    });
  }

  const status = await readProviderKeyStatus(input);
  return storedRecord
    ? status
    : {
        ...status,
        validation
      };
}

export async function validateProviderApiKey(
  provider: ExternalProvider,
  apiKey: string
): Promise<ProviderKeyValidationResult> {
  const normalizedApiKey = normalizeApiKey(apiKey);
  const checkedAt = new Date().toISOString();

  if (provider !== "gemini") {
    return {
      status: "validation-error",
      checkedAt,
      detail: `Unsupported provider validation: ${provider}`,
      target: getProviderValidationTarget(provider)
    };
  }

  try {
    const response = await fetch(GEMINI_VALIDATION_URL, {
      method: "GET",
      headers: {
        "x-goog-api-key": normalizedApiKey
      }
    });
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string }; models?: Array<{ name?: string }> }
      | null;

    if (response.ok) {
      const modelName = payload?.models?.[0]?.name ?? `models/${DEFAULT_GEMINI_MODEL}`;
      return {
        status: "valid",
        checkedAt,
        detail: `Validated against ${getProviderValidationTarget(provider)}; first visible model: ${modelName}.`,
        target: getProviderValidationTarget(provider)
      };
    }

    return {
      status: response.status === 400 || response.status === 401 || response.status === 403 ? "invalid" : "validation-error",
      checkedAt,
      detail: sanitizeValidationDetail(payload?.error?.message) ?? `Gemini validation failed with status ${response.status}.`,
      target: getProviderValidationTarget(provider)
    };
  } catch (error) {
    return {
      status: "validation-error",
      checkedAt,
      detail: sanitizeValidationDetail(error instanceof Error ? error.message : String(error)),
      target: getProviderValidationTarget(provider)
    };
  }
}

function getProviderLabel(provider: ExternalProvider): string {
  return provider === "gemini" ? "Google Gemini" : provider;
}

function getProviderValidationTarget(provider: ExternalProvider): string {
  return provider === "gemini" ? "GET /v1beta/models?pageSize=1" : provider;
}

function readProviderKeyFromEnv(
  env: Pick<Env, "GEMINI_API_KEY">,
  provider: ExternalProvider
): string | null {
  if (provider !== "gemini") {
    return null;
  }

  return normalizeOptionalSecret(env.GEMINI_API_KEY);
}

async function readStoredProviderKeyRecord(
  database: D1Database,
  provider: ExternalProvider
): Promise<StoredProviderKeyRecord | null> {
  const result = await database
    .prepare(SELECT_PROVIDER_KEY_SQL)
    .bind(SETTINGS_SESSION_ID, PROVIDER_KEY_ENTITY, provider)
    .all<{ value_json: string }>();

  return parseStoredProviderKeyRecord(result.results[0]?.value_json);
}

async function writeStoredProviderKeyRecord(
  database: D1Database,
  provider: ExternalProvider,
  record: StoredProviderKeyRecord
): Promise<void> {
  const latestTxResult = await database
    .prepare(SELECT_LATEST_SETTINGS_TX_SQL)
    .bind(SETTINGS_SESSION_ID)
    .all<{ tx: number }>();
  const latestTx = Number(latestTxResult.results[0]?.tx ?? 0);
  const tx = Math.max(Date.now(), latestTx + 1);

  await database
    .prepare(INSERT_PROVIDER_KEY_SQL)
    .bind(
      SETTINGS_SESSION_ID,
      PROVIDER_KEY_ENTITY,
      provider,
      JSON.stringify(record),
      tx,
      0,
      new Date().toISOString(),
      "assert"
    )
    .run();
}

function parseStoredProviderKeyRecord(valueJson: string | undefined): StoredProviderKeyRecord | null {
  if (!valueJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(valueJson) as Partial<StoredProviderKeyRecord>;
    if (
      typeof parsed.ciphertext !== "string" ||
      typeof parsed.iv !== "string" ||
      typeof parsed.maskedKey !== "string" ||
      typeof parsed.fingerprint !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      typeof parsed.validation !== "object" ||
      parsed.validation === null
    ) {
      return null;
    }

    return parsed as StoredProviderKeyRecord;
  } catch {
    return null;
  }
}

async function encryptSecret(secret: string, authToken: string | undefined) {
  const key = await deriveEncryptionKey(authToken);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(secret)
  );

  return {
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    iv: encodeBase64(iv)
  };
}

async function decryptSecret(
  record: StoredProviderKeyRecord,
  authToken: string | undefined
): Promise<string> {
  const key = await deriveEncryptionKey(authToken);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64(record.iv) },
    key,
    decodeBase64(record.ciphertext)
  );

  return new TextDecoder().decode(plaintext);
}

async function deriveEncryptionKey(authToken: string | undefined): Promise<CryptoKey> {
  const normalizedAuthToken = normalizeOptionalSecret(authToken);
  if (!normalizedAuthToken) {
    throw new Error("APP_AUTH_TOKEN must be configured before protected key storage can be used");
  }

  const rawKey = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${ENCRYPTION_CONTEXT}:${normalizedAuthToken}`)
  );

  return crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function fingerprintSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

function maskSecret(secret: string): string {
  const normalized = normalizeApiKey(secret);
  const suffix = normalized.slice(-4);
  return suffix ? `••••••••${suffix}` : "••••";
}

function normalizeApiKey(apiKey: string): string {
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) {
    throw new Error("apiKey must not be empty");
  }

  return normalizedApiKey;
}

function normalizeOptionalSecret(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sanitizeValidationDetail(detail: string | undefined | null): string | null {
  if (!detail) {
    return null;
  }

  return detail.replace(/\s+/g, " ").trim().slice(0, 240) || null;
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}