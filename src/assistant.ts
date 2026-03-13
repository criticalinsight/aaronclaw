import {
  compareAaronDbEdgeVectors,
  fingerprintAaronDbEdgeValue
} from "./aarondb-edge-substrate";
import type { KnowledgeVaultMatch } from "./knowledge-vault";
import { getConfiguredWorkersAiModel } from "./model-registry";
import type { RecallMatch, SessionEvent, SessionRecord } from "./session-state";

const GEMINI_GENERATE_CONTENT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_TRANSCRIPT_MESSAGES = 8;
const MAX_RECALL_MATCHES = 3;
const MAX_PREFETCH_MATCHES = 4;
const PERSONA_NAME = "AaronClaw";
const PERSONA_GOAL =
  "Provide practical, concise browser-first assistance grounded in AaronDB-backed session memory.";
const SEMANTIC_VECTOR_DIMENSIONS = 24;
const PROMPT_PREVIEW_LENGTH = 180;
const SEMANTIC_EXPANSIONS: Record<string, string[]> = {
  agent: ["assistant", "persona"],
  assistant: ["agent", "persona", "aaronclaw"],
  context: ["memory", "recall"],
  d1: ["database", "facts", "storage"],
  database: ["d1", "facts", "storage"],
  facts: ["memory", "replay", "state"],
  memory: ["remember", "recall", "persist", "context"],
  persist: ["store", "memory", "facts"],
  persona: ["assistant", "identity", "agent"],
  recall: ["memory", "retrieve", "search"],
  remember: ["memory", "recall", "persist"],
  replay: ["rehydrate", "history", "facts"],
  rehydrate: ["replay", "restore", "state"],
  search: ["recall", "retrieve", "lookup"],
  session: ["conversation", "history", "state"],
  state: ["memory", "session", "facts"],
  storage: ["database", "persist", "d1"],
  tool: ["action", "event", "search"]
};
const NOISY_TERMS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "from",
  "how",
  "in",
  "is",
  "of",
  "on",
  "or",
  "please",
  "that",
  "the",
  "this",
  "to",
  "what",
  "with",
  "your"
]);

type AssistantPersonaAttribute =
  | "type"
  | "name"
  | "role"
  | "goal"
  | "runtime"
  | "memorySource"
  | "session"
  | "lastActiveAt"
  | "activeIntent"
  | "prefetchStrategy"
  | "prefetchCount"
  | "hyperRecallStrategy"
  | "hyperRecallCount";

type SemanticPrefetchSource = "session-event" | "recall" | "knowledge-vault";

export interface AssistantPersonaFact {
  entity: string;
  attribute: AssistantPersonaAttribute;
  value: number | string;
}

export interface SemanticPrefetchMatch {
  eventId: string;
  kind: SessionEvent["kind"] | "recall";
  preview: string;
  score: number;
  source: SemanticPrefetchSource;
}

export interface AssistantPersonaRuntime {
  adapter: "aarondb-persona-compat";
  personaEntity: string;
  facts: AssistantPersonaFact[];
  prefetchedContext: SemanticPrefetchMatch[];
  promptMessages: WorkersAiMessage[];
}

export interface AssistantProviderRoute {
  provider: "workers-ai" | "gemini";
  model: string;
  apiKey?: string | null;
}

type AssistantFallbackReason =
  | "no-ai-binding"
  | "ai-error"
  | "ai-empty-response"
  | "provider-key-not-ready"
  | "provider-error"
  | "provider-empty-response";

export interface AssistantReply {
  content: string;
  model: string | null;
  recallMatches: RecallMatch[];
  source: "workers-ai" | "gemini" | "fallback";
  fallbackReason: AssistantFallbackReason | null;
  fallbackDetail: string | null;
}

export function buildAssistantPersonaRuntime(input: {
  session: SessionRecord;
  sessionId: string;
  userMessage: string;
  recallMatches: RecallMatch[];
  knowledgeVaultMatches: KnowledgeVaultMatch[];
  promptAdditions?: string[];
}): AssistantPersonaRuntime {
  const recallMatches = input.recallMatches.slice(0, MAX_RECALL_MATCHES);
  const personaEntity = `persona:${input.sessionId}:aaronclaw`;
  const prefetchedContext = prefetchSemanticContext({
    session: input.session,
    userMessage: input.userMessage,
    recallMatches,
    knowledgeVaultMatches: input.knowledgeVaultMatches
  });
  const facts = buildPersonaFacts({
    personaEntity,
    session: input.session,
    userMessage: input.userMessage,
    prefetchedContext,
    knowledgeVaultMatches: input.knowledgeVaultMatches
  });

  return {
    adapter: "aarondb-persona-compat",
    personaEntity,
    facts,
    prefetchedContext,
    promptMessages: buildPromptMessages(
      input.session,
      input.userMessage,
      facts,
      prefetchedContext,
      input.promptAdditions ?? []
    )
  };
}

export async function generateAssistantReply(input: {
  env: Env;
  session: SessionRecord;
  sessionId: string;
  userMessage: string;
  recallMatches: RecallMatch[];
  knowledgeVaultMatches: KnowledgeVaultMatch[];
  primaryRoute?: AssistantProviderRoute | null;
  fallbackRoute?: AssistantProviderRoute | null;
  promptAdditions?: string[];
}): Promise<AssistantReply> {
  const recallMatches = input.recallMatches.slice(0, MAX_RECALL_MATCHES);
  const personaRuntime = buildAssistantPersonaRuntime({
    session: input.session,
    sessionId: input.sessionId,
    userMessage: input.userMessage,
    recallMatches,
    knowledgeVaultMatches: input.knowledgeVaultMatches,
    promptAdditions: input.promptAdditions
  });

  const primaryRoute =
    input.primaryRoute ??
    (input.env.AI
      ? {
          provider: "workers-ai",
          model: getConfiguredWorkersAiModel(input.env)
        }
      : null);
  const primaryAttempt = primaryRoute
    ? await attemptAssistantRoute({
        env: input.env,
        sessionId: input.sessionId,
        route: primaryRoute,
        promptMessages: personaRuntime.promptMessages
      })
    : buildNoRouteFailure();

  if (primaryAttempt.ok) {
    return {
      content: primaryAttempt.content,
      model: primaryAttempt.model,
      recallMatches,
      source: primaryAttempt.source,
      fallbackReason: null,
      fallbackDetail: null
    };
  }

  const fallbackRoute =
    input.fallbackRoute && !isSameAssistantRoute(primaryRoute, input.fallbackRoute)
      ? input.fallbackRoute
      : null;

  if (fallbackRoute) {
    const fallbackAttempt = await attemptAssistantRoute({
      env: input.env,
      sessionId: input.sessionId,
      route: fallbackRoute,
      promptMessages: personaRuntime.promptMessages
    });

    if (fallbackAttempt.ok) {
      console.warn("assistant provider fallback engaged", {
        sessionId: input.sessionId,
        requestedProvider: primaryRoute?.provider ?? null,
        requestedModel: primaryRoute?.model ?? null,
        activeProvider: fallbackAttempt.source,
        activeModel: fallbackAttempt.model,
        fallbackReason: primaryAttempt.fallbackReason,
        fallbackDetail: primaryAttempt.fallbackDetail
      });

      return {
        content: fallbackAttempt.content,
        model: fallbackAttempt.model,
        recallMatches,
        source: fallbackAttempt.source,
        fallbackReason: primaryAttempt.fallbackReason,
        fallbackDetail: `${primaryAttempt.fallbackDetail} Fell back to ${describeAssistantRoute(fallbackRoute)}.`
      };
    }

    return {
      content: buildFallbackReply({
        userMessage: input.userMessage,
        sessionId: input.sessionId,
        prefetchedContext: personaRuntime.prefetchedContext,
        reason: primaryAttempt.fallbackReason,
        model: primaryAttempt.model,
        provider: primaryAttempt.provider
      }),
      model: primaryAttempt.model,
      recallMatches,
      source: "fallback",
      fallbackReason: primaryAttempt.fallbackReason,
      fallbackDetail:
        `${primaryAttempt.fallbackDetail} Secondary fallback ${describeAssistantRoute(fallbackRoute)} also failed: ` +
        fallbackAttempt.fallbackDetail
    };
  }

  return {
    content: buildFallbackReply({
      userMessage: input.userMessage,
      sessionId: input.sessionId,
      prefetchedContext: personaRuntime.prefetchedContext,
      reason: primaryAttempt.fallbackReason,
      model: primaryAttempt.model,
      provider: primaryAttempt.provider
    }),
    model: primaryAttempt.model,
    recallMatches,
    source: "fallback",
    fallbackReason: primaryAttempt.fallbackReason,
    fallbackDetail: primaryAttempt.fallbackDetail
  };
}

type AssistantAttemptSuccess = {
  ok: true;
  source: "workers-ai" | "gemini";
  content: string;
  model: string;
};

type AssistantAttemptFailure = {
  ok: false;
  provider: AssistantProviderRoute["provider"];
  model: string | null;
  fallbackReason: AssistantFallbackReason;
  fallbackDetail: string;
};

async function attemptAssistantRoute(input: {
  env: Env;
  sessionId: string;
  route: AssistantProviderRoute;
  promptMessages: WorkersAiMessage[];
}): Promise<AssistantAttemptSuccess | AssistantAttemptFailure> {
  if (input.route.provider === "gemini") {
    return attemptGeminiRoute(input);
  }

  return attemptWorkersAiRoute(input);
}

async function attemptWorkersAiRoute(input: {
  env: Env;
  sessionId: string;
  route: AssistantProviderRoute;
  promptMessages: WorkersAiMessage[];
}): Promise<AssistantAttemptSuccess | AssistantAttemptFailure> {
  if (!input.env.AI) {
    return buildNoRouteFailure();
  }

  try {
    const result = await input.env.AI.run(input.route.model, {
      messages: input.promptMessages,
      max_tokens: 2560, // Reduced from 4096 for stable edge inference
      temperature: 0.2
    });
    const content = extractResponseText(result);

    if (content) {
      return {
        ok: true,
        content,
        model: input.route.model,
        source: "workers-ai"
      };
    }

    const fallbackDetail = buildAiEmptyResponseDetail(result);
    console.warn("workers ai returned no usable response text", {
      sessionId: input.sessionId,
      model: input.route.model,
      fallbackDetail
    });

    return {
      ok: false,
      provider: "workers-ai",
      model: input.route.model,
      fallbackReason: "ai-empty-response",
      fallbackDetail
    };
  } catch (error) {
    const fallbackDetail = buildAiErrorDetail(error);
    console.error(
      "workers ai request failed",
      {
        sessionId: input.sessionId,
        model: input.route.model,
        fallbackDetail
      },
      error
    );

    return {
      ok: false,
      provider: "workers-ai",
      model: input.route.model,
      fallbackReason: "ai-error",
      fallbackDetail
    };
  }
}

async function attemptGeminiRoute(input: {
  sessionId: string;
  route: AssistantProviderRoute;
  promptMessages: WorkersAiMessage[];
}): Promise<AssistantAttemptSuccess | AssistantAttemptFailure> {
  const apiKey = input.route.apiKey?.trim();
  if (!apiKey) {
    return {
      ok: false,
      provider: "gemini",
      model: input.route.model,
      fallbackReason: "provider-key-not-ready",
      fallbackDetail:
        "Google Gemini is selected but no validated API key could be resolved for runtime use."
    };
  }

  try {
    const response = await fetch(buildGeminiGenerateContentUrl(input.route.model), {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(buildGeminiGenerateContentRequest(input.promptMessages))
    });
    const payload = (await response.json().catch(() => null)) as unknown;

    if (!response.ok) {
      const fallbackDetail = buildGeminiHttpErrorDetail(response.status, payload);
      console.error("gemini request failed", {
        sessionId: input.sessionId,
        model: input.route.model,
        fallbackDetail
      });
      return {
        ok: false,
        provider: "gemini",
        model: input.route.model,
        fallbackReason: "provider-error",
        fallbackDetail
      };
    }

    const content = extractGeminiResponseText(payload);
    if (content) {
      return {
        ok: true,
        content,
        model: input.route.model,
        source: "gemini"
      };
    }

    const fallbackDetail = buildGeminiEmptyResponseDetail(payload);
    console.warn("gemini returned no usable response text", {
      sessionId: input.sessionId,
      model: input.route.model,
      fallbackDetail
    });
    return {
      ok: false,
      provider: "gemini",
      model: input.route.model,
      fallbackReason: "provider-empty-response",
      fallbackDetail
    };
  } catch (error) {
    const fallbackDetail = buildGeminiThrownErrorDetail(error);
    console.error(
      "gemini request failed",
      {
        sessionId: input.sessionId,
        model: input.route.model,
        fallbackDetail
      },
      error
    );
    return {
      ok: false,
      provider: "gemini",
      model: input.route.model,
      fallbackReason: "provider-error",
      fallbackDetail
    };
  }
}

function buildNoRouteFailure(): AssistantAttemptFailure {
  return {
    ok: false,
    provider: "workers-ai",
    model: null,
    fallbackReason: "no-ai-binding",
    fallbackDetail: "Workers AI binding is not configured for this deployment."
  };
}

function isSameAssistantRoute(
  left: AssistantProviderRoute | null | undefined,
  right: AssistantProviderRoute | null | undefined
): boolean {
  if (!left || !right) {
    return false;
  }

  return left.provider === right.provider && left.model === right.model;
}

function describeAssistantRoute(route: AssistantProviderRoute): string {
  return route.provider === "gemini"
    ? `Google Gemini (${route.model})`
    : `Workers AI (${route.model})`;
}

function buildGeminiGenerateContentUrl(model: string): string {
  return `${GEMINI_GENERATE_CONTENT_BASE_URL}/${encodeURIComponent(model)}:generateContent`;
}

function buildGeminiGenerateContentRequest(promptMessages: WorkersAiMessage[]) {
  const systemInstruction = promptMessages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const contents = promptMessages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }]
    }));

  return {
    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    contents,
    generationConfig: {
      maxOutputTokens: 8192,
      temperature: 0.2
    }
  };
}

function extractGeminiResponseText(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) return null;
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  for (const candidate of candidates) {
    const contentObj = asRecord(asRecord(candidate)?.content);
    if (!contentObj) continue;
    const parts = Array.isArray(contentObj.parts) ? contentObj.parts : [];
    const text = parts
      .map((part) => asRecord(part)?.text)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n\n")
      .trim();
    if (text) {
      return text;
    }
  }

  return null;
}

function buildGeminiHttpErrorDetail(status: number, payload: unknown): string {
  const errorMessage = asRecord(asRecord(payload)?.error)?.message;
  return typeof errorMessage === "string" && errorMessage.trim().length > 0
    ? `Google Gemini request failed with status ${status}: ${errorMessage.trim()}`
    : `Google Gemini request failed with status ${status}.`;
}

function buildGeminiThrownErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return `Google Gemini request failed with ${error.name}: ${error.message}`;
  }

  if (typeof error === "string" && error.trim()) {
    return `Google Gemini request failed with non-Error throw: ${error.trim()}`;
  }

  return "Google Gemini threw before producing a usable response. Check Worker logs for the underlying provider/runtime error.";
}

function buildGeminiEmptyResponseDetail(payload: unknown): string {
  const record = asRecord(payload);
  const promptFeedback = asRecord(record?.promptFeedback);
  const blockReason = promptFeedback?.blockReason;
  if (typeof blockReason === "string" && blockReason.trim().length > 0) {
    return `Google Gemini returned no response text. promptFeedback.blockReason=${blockReason.trim()}.`;
  }

  if (!record) {
    return "Google Gemini returned no response text and no structured response payload.";
  }
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  const candidate = asRecord(candidates[0]);
  const finishReason = candidate?.finishReason;
  if (typeof finishReason === "string" && finishReason.trim().length > 0) {
    return `Google Gemini returned no response text. finishReason=${finishReason.trim()}.`;
  }

  const keys = Object.keys(record).slice(0, 5);
  return keys.length > 0
    ? `Google Gemini returned no response text. Top-level payload keys: ${keys.join(", ")}.`
    : "Google Gemini returned no response text and no structured response payload.";
}

function buildPersonaFacts(input: {
  personaEntity: string;
  session: SessionRecord;
  userMessage: string;
  prefetchedContext: SemanticPrefetchMatch[];
  knowledgeVaultMatches: KnowledgeVaultMatch[];
}): AssistantPersonaFact[] {
  return [
    { entity: input.personaEntity, attribute: "type", value: "persona" },
    { entity: input.personaEntity, attribute: "name", value: PERSONA_NAME },
    { entity: input.personaEntity, attribute: "role", value: "assistant" },
    { entity: input.personaEntity, attribute: "goal", value: PERSONA_GOAL },
    { entity: input.personaEntity, attribute: "runtime", value: "cloudflare-worker" },
    {
      entity: input.personaEntity,
      attribute: "memorySource",
      value: input.session.memorySource
    },
    { entity: input.personaEntity, attribute: "session", value: input.session.id },
    {
      entity: input.personaEntity,
      attribute: "lastActiveAt",
      value: input.session.lastActiveAt
    },
    {
      entity: input.personaEntity,
      attribute: "activeIntent",
      value: trimText(input.userMessage, 220)
    },
    {
      entity: input.personaEntity,
      attribute: "prefetchStrategy",
      value: "aarondb-semantic-compat"
    },
    {
      entity: input.personaEntity,
      attribute: "prefetchCount",
      value: input.prefetchedContext.length
    },
    {
      entity: input.personaEntity,
      attribute: "hyperRecallStrategy",
      value: input.knowledgeVaultMatches.length > 0 ? "vectorize-knowledge-vault-compat" : "idle"
    },
    {
      entity: input.personaEntity,
      attribute: "hyperRecallCount",
      value: input.knowledgeVaultMatches.length
    }
  ];
}

function buildPromptMessages(
  session: SessionRecord,
  userMessage: string,
  personaFacts: AssistantPersonaFact[],
  prefetchedContext: SemanticPrefetchMatch[],
  promptAdditions: string[]
): WorkersAiMessage[] {
  const messages: WorkersAiMessage[] = [
    {
      role: "system",
      content: buildPersonaSystemMessage(personaFacts)
    }
  ];

  if (prefetchedContext.length > 0) {
    messages.push({
      role: "system",
      content: buildPrefetchSystemMessage(prefetchedContext)
    });
  }

  for (const addition of promptAdditions) {
    if (!addition.trim()) {
      continue;
    }

    messages.push({
      role: "system",
      content: addition
    });
  }

  for (const message of session.messages.slice(-MAX_TRANSCRIPT_MESSAGES)) {
    messages.push({
      role: message.role,
      content: message.content
    });
  }

  if (session.messages[session.messages.length - 1]?.content !== userMessage) {
    messages.push({
      role: "user",
      content: userMessage
    });
  }

  return messages;
}

function buildPersonaSystemMessage(facts: AssistantPersonaFact[]): string {
  return [
    "AaronDB Persona runtime (compatibility layer):",
    ...facts.map((fact) => `- ${fact.attribute}: ${String(fact.value)}`),
    "Respond clearly and concisely. Prefer practical answers and use warmed AaronDB context only when it is relevant."
  ].join("\n");
}

function buildPrefetchSystemMessage(prefetchedContext: SemanticPrefetchMatch[]): string {
  return [
    "Semantic prefetch warmed context before final response generation:",
    ...prefetchedContext.map(
      (match, index) =>
        `${index + 1}. [${match.source} score=${match.score.toFixed(2)}] ${trimText(match.preview, PROMPT_PREVIEW_LENGTH)}`
    ),
    "Use the prefetched context if it helps answer the latest user request."
  ].join("\n");
}

function prefetchSemanticContext(input: {
  session: SessionRecord;
  userMessage: string;
  recallMatches: RecallMatch[];
  knowledgeVaultMatches: KnowledgeVaultMatch[];
}): SemanticPrefetchMatch[] {
  const candidates = collectSemanticCandidates(
    input.session,
    input.userMessage,
    input.recallMatches,
    input.knowledgeVaultMatches
  );

  if (candidates.length === 0) {
    return [];
  }

  const queryTerms = expandSemanticTerms(input.userMessage);
  const queryVector = buildSemanticVector(queryTerms);
  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreSemanticCandidate({
        candidate,
        queryTerms,
        queryVector,
        lastTx: input.session.lastTx
      })
    }))
    .filter(
      (candidate) =>
        candidate.score > 0 ||
        candidate.source === "recall" ||
        candidate.source === "knowledge-vault"
    )
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_PREFETCH_MATCHES)
    .map<SemanticPrefetchMatch>(({ eventId, kind, preview, score, source }) => ({
      eventId,
      kind,
      preview,
      score,
      source
    }));

  return ranked.length > 0
    ? ranked
    : input.recallMatches.slice(0, MAX_PREFETCH_MATCHES).map((match) => ({
        eventId: match.eventId,
        kind: match.kind,
        preview: match.preview,
        score: roundScore(match.score),
        source: "recall"
      }));
}

type SemanticCandidateSeed = {
  eventId: string;
  kind: SemanticPrefetchMatch["kind"];
  preview: string;
  source: SemanticPrefetchSource;
  tx: number;
  recallScore: number;
};

function collectSemanticCandidates(
  session: SessionRecord,
  userMessage: string,
  recallMatches: RecallMatch[],
  knowledgeVaultMatches: KnowledgeVaultMatch[]
): SemanticCandidateSeed[] {
  const candidates = new Map<string, SemanticCandidateSeed>();

  for (const event of session.events) {
    if (event.kind === "message" && event.role === "user" && event.content === userMessage) {
      continue;
    }

    const preview = previewSessionEvent(event);
    if (!preview) {
      continue;
    }

    candidates.set(event.id, {
      eventId: event.id,
      kind: event.kind,
      preview,
      source: "session-event",
      tx: event.tx,
      recallScore: 0
    });
  }

  for (const match of recallMatches) {
    const existing = candidates.get(match.eventId);
    candidates.set(match.eventId, {
      eventId: match.eventId,
      kind: match.kind,
      preview:
        match.preview.length >= (existing?.preview.length ?? 0)
          ? match.preview
          : existing?.preview ?? match.preview,
      source: "recall",
      tx: match.tx,
      recallScore: Math.max(existing?.recallScore ?? 0, match.score)
    });
  }

  for (const match of knowledgeVaultMatches) {
    candidates.set(`${match.sessionId}:${match.eventId}`, {
      eventId: match.eventId,
      kind: match.kind,
      preview: match.preview,
      source: "knowledge-vault",
      tx: 0,
      recallScore: Math.max(match.score, 0)
    });
  }

  return [...candidates.values()];
}

function scoreSemanticCandidate(input: {
  candidate: SemanticCandidateSeed;
  queryTerms: string[];
  queryVector: number[];
  lastTx: number;
}): number {
  const candidateTerms = expandSemanticTerms(input.candidate.preview);
  const overlap = scoreTermOverlap(input.queryTerms, candidateTerms);
  const candidateVector = buildSemanticVector(candidateTerms);
  const rawVectorScore =
    input.queryTerms.length > 0 && candidateTerms.length > 0
      ? compareAaronDbEdgeVectors(input.queryVector, candidateVector)
      : 0;
  const vectorScore = Number.isFinite(rawVectorScore) ? Math.max(0, rawVectorScore) : 0;
  const recallBoost = input.candidate.recallScore * 0.2;
  const recencyBoost = input.lastTx > 0 ? (input.candidate.tx / input.lastTx) * 0.05 : 0;

  return roundScore(overlap * 0.45 + vectorScore * 0.35 + recallBoost + recencyBoost);
}

function scoreTermOverlap(queryTerms: string[], candidateTerms: string[]): number {
  const querySet = new Set(queryTerms);

  if (querySet.size === 0) {
    return 0;
  }

  const candidateSet = new Set(candidateTerms);
  let overlap = 0;

  for (const term of querySet) {
    if (candidateSet.has(term)) {
      overlap += 1;
    }
  }

  return overlap / querySet.size;
}

function buildSemanticVector(terms: string[]): number[] {
  const vector = Array.from({ length: SEMANTIC_VECTOR_DIMENSIONS }, () => 0);

  for (const term of terms) {
    addVectorWeight(vector, term, 1);

    if (term.length > 4) {
      addVectorWeight(vector, term.slice(0, 4), 0.5);
    }
  }

  return vector;
}

function addVectorWeight(vector: number[], value: string, weight: number): void {
  const primarySlot = Math.abs(fingerprintAaronDbEdgeValue(value)) % vector.length;
  const secondarySlot = Math.abs(fingerprintAaronDbEdgeValue(`${value}:alt`)) % vector.length;

  vector[primarySlot] += weight;
  vector[secondarySlot] += weight / 2;
}

function expandSemanticTerms(value: string): string[] {
  const expanded = new Set<string>();

  for (const term of tokenize(value)) {
    if (NOISY_TERMS.has(term)) {
      continue;
    }

    expanded.add(term);

    for (const synonym of SEMANTIC_EXPANSIONS[term] ?? []) {
      expanded.add(synonym);
    }

    if (term.endsWith("ing") && term.length > 5) {
      expanded.add(term.slice(0, -3));
    }

    if (term.endsWith("ed") && term.length > 4) {
      expanded.add(term.slice(0, -2));
    }
  }

  return [...expanded];
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length > 1);
}

function previewSessionEvent(event: SessionEvent): string {
  return event.kind === "message" ? event.content : `${event.toolName}: ${event.summary}`;
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function extractResponseText(result: unknown): string | null {
  if (typeof result === "string" && result.trim()) {
    return result.trim();
  }

  if (!result || typeof result !== "object") {
    return null;
  }

  const maybeResponse = result as {
    response?: unknown;
    result?: { response?: unknown };
    choices?: Array<{ message?: { content?: unknown } }>;
  };

  if (typeof maybeResponse.response === "string" && maybeResponse.response.trim()) {
    return maybeResponse.response.trim();
  }

  if (
    typeof maybeResponse.result?.response === "string" &&
    maybeResponse.result.response.trim()
  ) {
    return maybeResponse.result.response.trim();
  }

  const choiceContent = maybeResponse.choices?.[0]?.message?.content;
  if (typeof choiceContent === "string" && choiceContent.trim()) {
    return choiceContent.trim();
  }

  return null;
}

function buildFallbackReply(
  input: {
    userMessage: string;
    sessionId: string;
    prefetchedContext: SemanticPrefetchMatch[];
    reason: AssistantFallbackReason;
    model: string | null;
    provider: "workers-ai" | "gemini";
  }
): string {
  const providerLabel = input.provider === "gemini" ? "Google Gemini" : "Workers AI";
  const runtimeLine =
    input.reason === "no-ai-binding"
      ? "Workers AI is not bound for this deployment, so this is the built-in deterministic fallback reply."
      : input.reason === "ai-empty-response" || input.reason === "provider-empty-response"
        ? `${providerLabel} ${input.model ? `(${input.model}) ` : ""}returned an empty response for this request, so this is the built-in deterministic fallback reply.`
        : input.reason === "provider-key-not-ready"
          ? `${providerLabel} ${input.model ? `(${input.model}) ` : ""}is selected but its validated key material is not ready for runtime use, so this is the built-in deterministic fallback reply.`
          : `${providerLabel} ${input.model ? `(${input.model}) ` : ""}failed for this request, so this is the built-in deterministic fallback reply.`;

  const memoryLine =
    input.prefetchedContext.length > 0
      ? `I also warmed relevant AaronDB context: ${input.prefetchedContext
          .map((match) => `“${trimText(match.preview, 100)}”`)
          .join("; ")}.`
      : "No persisted memory matched this prompt yet.";

  return [
    runtimeLine,
    `I saved your latest message in session ${input.sessionId}.`,
    memoryLine,
    `Latest prompt: “${trimText(input.userMessage, 220)}”`
  ].join(" ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function buildAiErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return `Workers AI request failed with ${error.name}: ${error.message}`;
  }

  if (typeof error === "string" && error.trim()) {
    return `Workers AI request failed with non-Error throw: ${error.trim()}`;
  }

  return "Workers AI threw before producing a usable response. Check Worker logs for the underlying provider/runtime error.";
}

function buildAiEmptyResponseDetail(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "Workers AI returned no response text and no structured response payload.";
  }

  const keys = Object.keys(result as Record<string, unknown>).slice(0, 5);
  return keys.length > 0
    ? `Workers AI returned no response text. Top-level payload keys: ${keys.join(", ")}.`
    : "Workers AI returned an empty object without response text.";
}

function trimText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}