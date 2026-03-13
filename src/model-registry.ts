export const DEFAULT_WORKERS_AI_MODEL = "@cf/nvidia/nemotron-3-120b-a12b";
export const REQUESTED_GEMINI_MODEL_INTENT = "gemini-3.1-pro-flash-preview";
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-pro-preview";

export type ModelProvider = "workers-ai" | "gemini";
export type ModelAvailabilityStatus =
  | "selectable"
  | "missing-binding"
  | "missing-key"
  | "configured-but-unavailable";
export type ModelSelectionFallbackReason =
  | "requested-model-unknown"
  | "requested-model-unavailable";

export interface ModelRegistryEntry {
  id: string;
  provider: ModelProvider;
  providerLabel: string;
  model: string;
  label: string;
  aliases: string[];
  selectable: boolean;
  availabilityStatus: ModelAvailabilityStatus;
  availabilityReason: string | null;
  routingStatus: "implemented" | "planned";
}

export interface ResolvedModelSelection {
  models: ModelRegistryEntry[];
  requestedModelId: string | null;
  requestedModel: ModelRegistryEntry | null;
  activeModelId: string | null;
  activeModel: ModelRegistryEntry | null;
  selectionFallbackReason: ModelSelectionFallbackReason | null;
}

export interface ModelRegistryOptions {
  geminiConfigured?: boolean;
  geminiValidationStatus?: "not-configured" | "unvalidated" | "valid" | "invalid" | "validation-error";
}

export function getConfiguredWorkersAiModel(env: Pick<Env, "AI_MODEL">): string {
  return env.AI_MODEL?.trim() || DEFAULT_WORKERS_AI_MODEL;
}

export function buildModelRegistry(
  env: Pick<Env, "AI" | "AI_MODEL" | "GEMINI_API_KEY">,
  options: ModelRegistryOptions = {}
): ModelRegistryEntry[] {
  const workersModel = getConfiguredWorkersAiModel(env);
  const geminiConfigured = options.geminiConfigured ?? Boolean(env.GEMINI_API_KEY?.trim());
  const geminiValidationStatus = options.geminiValidationStatus ?? (geminiConfigured ? "unvalidated" : "not-configured");
  const geminiSelectable = geminiValidationStatus === "valid";

  return [
    {
      id: `gemini:${DEFAULT_GEMINI_MODEL}`,
      provider: "gemini",
      providerLabel: "Google Gemini",
      model: DEFAULT_GEMINI_MODEL,
      label: `Gemini / ${DEFAULT_GEMINI_MODEL}`,
      aliases: [`gemini:${REQUESTED_GEMINI_MODEL_INTENT}`],
      selectable: geminiSelectable,
      availabilityStatus: geminiSelectable
        ? "selectable"
        : geminiConfigured
          ? "configured-but-unavailable"
          : "missing-key",
      availabilityReason: buildGeminiAvailabilityReason(geminiConfigured, geminiValidationStatus),
      routingStatus: "implemented"
    },
    {
      id: `workers-ai:${workersModel}`,
      provider: "workers-ai",
      providerLabel: "Workers AI",
      model: workersModel,
      label: `Workers AI / ${workersModel}`,
      aliases: [],
      selectable: Boolean(env.AI),
      availabilityStatus: env.AI ? "selectable" : "missing-binding",
      availabilityReason: env.AI
        ? null
        : "Workers AI binding is not configured for this deployment.",
      routingStatus: "implemented"
    }
  ];
}

export function normalizeModelSelectionId(modelId: string): string {
  const normalizedModelId = modelId.trim();

  if (normalizedModelId === `gemini:${REQUESTED_GEMINI_MODEL_INTENT}`) {
    return `gemini:${DEFAULT_GEMINI_MODEL}`;
  }

  return normalizedModelId;
}

export function resolveModelSelection(
  env: Pick<Env, "AI" | "AI_MODEL" | "GEMINI_API_KEY">,
  persistedModelId: string | null,
  options: ModelRegistryOptions = {}
): ResolvedModelSelection {
  const models = buildModelRegistry(env, options);
  const defaultModel = models.find((model) => model.provider === "gemini") ?? models[0] ?? null;
  const normalizedPersistedModelId = persistedModelId?.trim()
    ? normalizeModelSelectionId(persistedModelId)
    : null;
  const requestedModelId = normalizedPersistedModelId || defaultModel?.id || null;
  const requestedModel =
    models.find(
      (model) =>
        model.id === requestedModelId ||
        (requestedModelId !== null && model.aliases.includes(requestedModelId))
    ) ?? null;
  const activeModel = requestedModel?.selectable
    ? requestedModel
    : models.find((model) => model.selectable) ?? null;

  return {
    models,
    requestedModelId,
    requestedModel,
    activeModelId: activeModel?.id ?? null,
    activeModel,
    selectionFallbackReason:
      requestedModelId && !requestedModel
        ? "requested-model-unknown"
        : requestedModel && !requestedModel.selectable
          ? "requested-model-unavailable"
          : null
  };
}

function buildGeminiAvailabilityReason(
  geminiConfigured: boolean,
  geminiValidationStatus: NonNullable<ModelRegistryOptions["geminiValidationStatus"]>
): string | null {
  if (geminiValidationStatus === "valid") {
    return null;
  }

  if (!geminiConfigured) {
    return `Gemini requires validated key material before it can become selectable; requested target ${REQUESTED_GEMINI_MODEL_INTENT} is mapped to ${DEFAULT_GEMINI_MODEL}.`;
  }

  if (geminiValidationStatus === "invalid") {
    return `Gemini key material is configured but the last validation failed; requested target ${REQUESTED_GEMINI_MODEL_INTENT} is mapped to ${DEFAULT_GEMINI_MODEL} until the key is replaced or revalidated.`;
  }

  if (geminiValidationStatus === "validation-error") {
    return `Gemini key material is configured but the last validation could not confirm readiness; requested target ${REQUESTED_GEMINI_MODEL_INTENT} is mapped to ${DEFAULT_GEMINI_MODEL} until validation succeeds.`;
  }

  return `Gemini key material is configured but not yet validated through /api/key; requested target ${REQUESTED_GEMINI_MODEL_INTENT} is mapped to ${DEFAULT_GEMINI_MODEL}.`;
}