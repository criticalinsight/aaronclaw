import type { RecallMatch, SessionRecord } from "./session-state";

const DEFAULT_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const MAX_TRANSCRIPT_MESSAGES = 8;
const MAX_RECALL_MATCHES = 3;

export interface AssistantReply {
  content: string;
  model: string | null;
  recallMatches: RecallMatch[];
  source: "workers-ai" | "fallback";
  fallbackReason: "no-ai-binding" | "ai-unavailable" | null;
}

export function getConfiguredModel(env: Env): string {
  return env.AI_MODEL?.trim() || DEFAULT_AI_MODEL;
}

export async function generateAssistantReply(input: {
  env: Env;
  session: SessionRecord;
  sessionId: string;
  userMessage: string;
  recallMatches: RecallMatch[];
}): Promise<AssistantReply> {
  const recallMatches = input.recallMatches.slice(0, MAX_RECALL_MATCHES);

  if (!input.env.AI) {
    return {
      content: buildFallbackReply({
        userMessage: input.userMessage,
        sessionId: input.sessionId,
        recallMatches,
        reason: "no-ai-binding",
        model: null
      }),
      model: null,
      recallMatches,
      source: "fallback",
      fallbackReason: "no-ai-binding"
    };
  }

  const model = getConfiguredModel(input.env);

  try {
    const result = await input.env.AI.run(model, {
      messages: buildPromptMessages(input.session, input.userMessage, recallMatches),
      max_tokens: 400,
      temperature: 0.2
    });
    const content = extractResponseText(result);

    if (content) {
      return {
        content,
        model,
        recallMatches,
        source: "workers-ai",
        fallbackReason: null
      };
    }
  } catch {
    // Fall through to deterministic fallback copy for personal deployments.
  }

  return {
    content: buildFallbackReply({
      userMessage: input.userMessage,
      sessionId: input.sessionId,
      recallMatches,
      reason: "ai-unavailable",
      model
    }),
    model,
    recallMatches,
    source: "fallback",
    fallbackReason: "ai-unavailable"
  };
}

function buildPromptMessages(
  session: SessionRecord,
  userMessage: string,
  recallMatches: RecallMatch[]
): WorkersAiMessage[] {
  const messages: WorkersAiMessage[] = [
    {
      role: "system",
      content:
        "You are AaronClaw, a browser-first Cloudflare Worker assistant. Respond clearly and concisely. Prefer practical answers and use recalled session context when it is relevant."
    }
  ];

  if (recallMatches.length > 0) {
    messages.push({
      role: "system",
      content: `Relevant persisted memory:\n${recallMatches
        .map((match, index) => `${index + 1}. ${trimText(match.preview, 180)}`)
        .join("\n")}`
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
    recallMatches: RecallMatch[];
    reason: "no-ai-binding" | "ai-unavailable";
    model: string | null;
  }
): string {
  const runtimeLine =
    input.reason === "no-ai-binding"
      ? "Workers AI is not bound for this deployment, so this is the built-in deterministic fallback reply."
      : `Workers AI ${input.model ? `(${input.model}) ` : ""}was unavailable for this request, so this is the built-in deterministic fallback reply.`;

  const memoryLine =
    input.recallMatches.length > 0
      ? `I also found persisted context: ${input.recallMatches
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

function trimText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}