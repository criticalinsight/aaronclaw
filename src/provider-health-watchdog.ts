import { readPersistedModelSelection } from "./model-selection-store";
import { resolveModelSelection } from "./model-registry";
import { readProviderKeyStatus } from "./provider-key-store";
import {
  listRecentStoredReflectionArtifacts,
  type StoredReflectionArtifact
} from "./reflection-engine";
import { AaronDbEdgeSessionRepository, type JsonObject } from "./session-state";

const PROVIDER_HEALTH_SIGNAL_SESSION_ID = "improvement:provider-health-signals";
const MAX_RECENT_REFLECTIONS = 12;

export type ProviderHealthSurface = "provider-key" | "model-selection" | "chat-route" | "telegram-route";
export type ProviderHealthStatus = "healthy" | "degraded" | "unavailable" | "unknown";

export interface ProviderHealthFinding extends JsonObject {
  findingKey: string;
  surface: ProviderHealthSurface;
  status: ProviderHealthStatus;
  summary: string;
  detail: string | null;
  evidence: string[];
}

export interface ProviderHealthWatchdogResult {
  signalSessionId: string;
  findings: ProviderHealthFinding[];
  healthyCount: number;
  degradedCount: number;
  unavailableCount: number;
  unknownCount: number;
}

export async function runProviderHealthWatchdog(input: {
  env: Pick<
    Env,
    | "AARONDB"
    | "AI"
    | "AI_MODEL"
    | "APP_AUTH_TOKEN"
    | "GEMINI_API_KEY"
    | "TELEGRAM_BOT_TOKEN"
    | "TELEGRAM_WEBHOOK_SECRET"
  >;
  cron: string;
  timestamp?: string;
}): Promise<ProviderHealthWatchdogResult> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const geminiKeyStatus = await readProviderKeyStatus({
    env: input.env,
    database: input.env.AARONDB,
    provider: "gemini"
  });
  const persistedModelId = await readPersistedModelSelection(input.env.AARONDB);
  const selection = resolveModelSelection(input.env, persistedModelId, {
    geminiConfigured: geminiKeyStatus.configured,
    geminiValidationStatus: geminiKeyStatus.validation.status
  });
  const reflections = await listRecentStoredReflectionArtifacts(input.env.AARONDB, MAX_RECENT_REFLECTIONS);
  const chatReflections = reflections.filter((artifact) => !artifact.sourceSessionId.startsWith("telegram:"));
  const telegramReflections = reflections.filter((artifact) => artifact.sourceSessionId.startsWith("telegram:"));
  const telegramConfigured = Boolean(input.env.TELEGRAM_BOT_TOKEN?.trim());
  const telegramWebhookProtected = Boolean(input.env.TELEGRAM_WEBHOOK_SECRET?.trim());

  const findings = [
    buildProviderKeyFinding(geminiKeyStatus),
    buildModelSelectionFinding({
      persistedModelId,
      requestedModelId: selection.requestedModelId,
      activeModelId: selection.activeModelId,
      selectionFallbackReason: selection.selectionFallbackReason,
      activeProvider: selection.activeModel?.provider ?? null
    }),
    buildRouteFinding({
      findingKey: "chat-route-fallback-watch",
      summaryLabel: "chat route",
      surface: "chat-route",
      reflections: chatReflections
    }),
    buildTelegramRouteFinding({
      reflections: telegramReflections,
      telegramConfigured,
      telegramWebhookProtected
    })
  ];

  const result: ProviderHealthWatchdogResult = {
    signalSessionId: PROVIDER_HEALTH_SIGNAL_SESSION_ID,
    findings,
    healthyCount: findings.filter((finding) => finding.status === "healthy").length,
    degradedCount: findings.filter((finding) => finding.status === "degraded").length,
    unavailableCount: findings.filter((finding) => finding.status === "unavailable").length,
    unknownCount: findings.filter((finding) => finding.status === "unknown").length
  };

  const repository = new AaronDbEdgeSessionRepository(input.env.AARONDB, PROVIDER_HEALTH_SIGNAL_SESSION_ID);
  await repository.createSession(timestamp);
  await repository.appendToolEvent({
    timestamp,
    toolName: "provider-health-watchdog",
    summary: buildSignalSummary(result),
    metadata: {
      cron: input.cron,
      findings,
      healthyCount: result.healthyCount,
      degradedCount: result.degradedCount,
      unavailableCount: result.unavailableCount,
      unknownCount: result.unknownCount,
      requestedModelId: selection.requestedModelId,
      activeModelId: selection.activeModelId,
      selectionFallbackReason: selection.selectionFallbackReason
    }
  });

  return result;
}

function buildProviderKeyFinding(input: Awaited<ReturnType<typeof readProviderKeyStatus>>): ProviderHealthFinding {
  if (input.validation.status === "valid") {
    return {
      findingKey: "gemini-key-readiness",
      surface: "provider-key",
      status: "healthy",
      summary: "Gemini key material is validated for runtime use.",
      detail: input.validation.detail,
      evidence: [
        `source=${input.source}`,
        `storage=${input.storage}`,
        `validationStatus=${input.validation.status}`,
        `target=${input.validation.target}`
      ]
    };
  }

  return {
    findingKey: "gemini-key-readiness",
    surface: "provider-key",
    status: input.validation.status === "not-configured" ? "unavailable" : "degraded",
    summary:
      input.validation.status === "not-configured"
        ? "Gemini key material is not configured, so Gemini cannot become an active validated route."
        : "Gemini key material is present but not ready for validated runtime use.",
    detail: input.validation.detail,
    evidence: [
      `configured=${String(input.configured)}`,
      `source=${input.source}`,
      `validationStatus=${input.validation.status}`,
      `target=${input.validation.target}`
    ]
  };
}

function buildModelSelectionFinding(input: {
  persistedModelId: string | null;
  requestedModelId: string | null;
  activeModelId: string | null;
  selectionFallbackReason: string | null;
  activeProvider: "workers-ai" | "gemini" | null;
}): ProviderHealthFinding {
  if (!input.activeModelId) {
    return {
      findingKey: "assistant-model-selection",
      surface: "model-selection",
      status: "unavailable",
      summary: "No selectable assistant model is currently available.",
      detail: "The runtime would have to rely on deterministic fallback until a selectable route is restored.",
      evidence: [
        `persistedModelId=${input.persistedModelId ?? "none"}`,
        `requestedModelId=${input.requestedModelId ?? "none"}`,
        "activeModelId=none",
        `selectionFallbackReason=${input.selectionFallbackReason ?? "none"}`
      ]
    };
  }

  if (input.selectionFallbackReason) {
    return {
      findingKey: "assistant-model-selection",
      surface: "model-selection",
      status: "degraded",
      summary: `The requested operator-facing model route is degraded and the runtime is using ${input.activeModelId} instead.`,
      detail: `Selection fallback reason: ${input.selectionFallbackReason}.`,
      evidence: [
        `persistedModelId=${input.persistedModelId ?? "none"}`,
        `requestedModelId=${input.requestedModelId ?? "none"}`,
        `activeModelId=${input.activeModelId}`,
        `activeProvider=${input.activeProvider ?? "none"}`,
        `selectionFallbackReason=${input.selectionFallbackReason}`
      ]
    };
  }

  return {
    findingKey: "assistant-model-selection",
    surface: "model-selection",
    status: "healthy",
    summary: `The requested model route is active on ${input.activeModelId}.`,
    detail: null,
    evidence: [
      `persistedModelId=${input.persistedModelId ?? "none"}`,
      `requestedModelId=${input.requestedModelId ?? "none"}`,
      `activeModelId=${input.activeModelId}`,
      `activeProvider=${input.activeProvider ?? "none"}`
    ]
  };
}

function buildTelegramRouteFinding(input: {
  reflections: StoredReflectionArtifact[];
  telegramConfigured: boolean;
  telegramWebhookProtected: boolean;
}): ProviderHealthFinding {
  if (!input.telegramConfigured || !input.telegramWebhookProtected) {
    return {
      findingKey: "telegram-route-watch",
      surface: "telegram-route",
      status: "unavailable",
      summary: "Telegram route configuration is incomplete.",
      detail: !input.telegramConfigured
        ? "TELEGRAM_BOT_TOKEN is missing."
        : "TELEGRAM_WEBHOOK_SECRET is missing.",
      evidence: [
        `telegramBotTokenConfigured=${String(input.telegramConfigured)}`,
        `telegramWebhookSecretConfigured=${String(input.telegramWebhookProtected)}`
      ]
    };
  }

  return buildRouteFinding({
    findingKey: "telegram-route-watch",
    summaryLabel: "Telegram route",
    surface: "telegram-route",
    reflections: input.reflections,
    extraEvidence: [
      `telegramBotTokenConfigured=${String(input.telegramConfigured)}`,
      `telegramWebhookSecretConfigured=${String(input.telegramWebhookProtected)}`
    ]
  });
}

function buildRouteFinding(input: {
  findingKey: string;
  summaryLabel: string;
  surface: ProviderHealthSurface;
  reflections: StoredReflectionArtifact[];
  extraEvidence?: string[];
}): ProviderHealthFinding {
  const fallbackSignals = input.reflections.filter((artifact) =>
    artifact.improvementSignals.some((signal) => signal.signalKey === "assistant-fallback-observed")
  );
  const latestFallback = fallbackSignals[fallbackSignals.length - 1] ?? null;
  const evidence = [
    `reviewedReflectionCount=${input.reflections.length}`,
    `fallbackSignalCount=${fallbackSignals.length}`,
    ...(input.extraEvidence ?? [])
  ];

  if (input.reflections.length === 0) {
    return {
      findingKey: input.findingKey,
      surface: input.surface,
      status: "unknown",
      summary: `No recent ${input.summaryLabel} reflections were available for watchdog review.`,
      detail: "The bounded watchdog window did not contain reflected sessions for this route.",
      evidence
    };
  }

  if (fallbackSignals.length > 0) {
    return {
      findingKey: input.findingKey,
      surface: input.surface,
      status: "degraded",
      summary: `Recent ${input.summaryLabel} reflections recorded deterministic fallback activity.`,
      detail: latestFallback
        ? `Latest reflected session with fallback: ${latestFallback.sourceSessionId}.`
        : null,
      evidence: [
        ...evidence,
        ...(latestFallback
          ? [
              `latestFallbackSessionId=${latestFallback.sourceSessionId}`,
              `latestFallbackReflectionId=${latestFallback.reflectionSessionId}`
            ]
          : [])
      ]
    };
  }

  return {
    findingKey: input.findingKey,
    surface: input.surface,
    status: "healthy",
    summary: `Recent ${input.summaryLabel} reflections show no fallback signals in the bounded watchdog window.`,
    detail: null,
    evidence
  };
}

function buildSignalSummary(result: ProviderHealthWatchdogResult): string {
  return [
    "Provider health watchdog recorded structured findings.",
    `${result.healthyCount} healthy, ${result.degradedCount} degraded, ${result.unavailableCount} unavailable, ${result.unknownCount} unknown.`
  ].join(" ");
}