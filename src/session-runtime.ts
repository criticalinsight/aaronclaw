import {
  type JsonValue,
  type JsonObject,
  type MessageRole,
  type SessionStateRepository
} from "./session-state";
import { mountAaronDbEdgeSessionRuntime } from "./aarondb-edge-substrate";
import { type AssistantProviderRoute, generateAssistantReply } from "./assistant";
import { queryKnowledgeVault } from "./knowledge-vault";
import { resolveModelSelection } from "./model-registry";
import { readPersistedModelSelection } from "./model-selection-store";
import { readProviderKeyStatus, resolveProviderApiKey } from "./provider-key-store";
import { reflectSession } from "./reflection-engine";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8"
    }
  });
}

export class SessionRuntime {
  private repository: SessionStateRepository | null = null;
  private activeSessionId: string | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId");

    if (!sessionId) {
      return json({ error: "sessionId is required" }, 400);
    }

    const repository = this.getRepository(sessionId);

    if (request.method === "POST" && url.pathname === "/init") {
      const session = await repository.createSession(new Date().toISOString());

      return json({ session }, 201);
    }

    if (request.method === "GET" && url.pathname === "/state") {
      const session = await repository.getSession({
        asOf: parseOptionalInteger(url.searchParams.get("asOf"))
      });

      return session
        ? json({ session })
        : json({ error: "session not initialized" }, 404);
    }

    if (request.method === "POST" && url.pathname === "/messages") {
      const body = await request.json().catch(() => null);

      if (!isJsonObject(body) || !isMessageRole(body.role) || typeof body.content !== "string") {
        return json({ error: "role and content are required" }, 400);
      }

      try {
        const session = await repository.appendMessage({
          timestamp: new Date().toISOString(),
          role: body.role,
          content: body.content,
          metadata: isJsonObject(body.metadata) ? body.metadata : undefined
        });

        return json({ session }, 201);
      } catch (error) {
        return handleRepositoryError(error);
      }
    }

    if (request.method === "POST" && url.pathname === "/chat") {
      const body = await request.json().catch(() => null);

      if (!isJsonObject(body) || typeof body.content !== "string") {
        return json({ error: "content is required" }, 400);
      }

      const content = body.content.trim();
      if (!content) {
        return json({ error: "content must not be empty" }, 400);
      }

      try {
        const userSession = await repository.appendMessage({
          timestamp: new Date().toISOString(),
          role: "user",
          content,
          metadata: isJsonObject(body.metadata) ? body.metadata : undefined
        });
        const recallMatches = await repository.recall({
          query: content,
          limit: 3
        });
        const knowledgeVault = await queryKnowledgeVault({
          env: this.env,
          sessionId,
          query: content,
          limit: 3
        });
        const persistedModelId = await readPersistedModelSelection(this.env.AARONDB);
        const geminiKeyStatus = await readProviderKeyStatus({
          env: this.env,
          database: this.env.AARONDB,
          provider: "gemini"
        });
        const modelSelection = resolveModelSelection(this.env, persistedModelId, {
          geminiConfigured: geminiKeyStatus.configured,
          geminiValidationStatus: geminiKeyStatus.validation.status
        });
        const geminiApiKey =
          geminiKeyStatus.validation.status === "valid"
            ? await resolveProviderApiKey({
                env: this.env,
                database: this.env.AARONDB,
                provider: "gemini"
              })
            : null;
        const assistant = await generateAssistantReply({
          env: this.env,
          session: userSession,
          sessionId,
          userMessage: content,
          recallMatches,
          knowledgeVaultMatches: knowledgeVault.matches,
          primaryRoute: buildAssistantRoute(modelSelection.activeModel, geminiApiKey),
          fallbackRoute: buildFallbackAssistantRoute(modelSelection, geminiApiKey)
        });
        const session = await repository.appendMessage({
          timestamp: new Date().toISOString(),
          role: "assistant",
          content: assistant.content,
          metadata: {
            model: assistant.model ?? "fallback",
            knowledgeVaultMatchCount: knowledgeVault.matches.length,
            knowledgeVaultSource: knowledgeVault.source,
            recallMatchCount: assistant.recallMatches.length,
            source: assistant.source,
            ...(persistedModelId ? { requestedModelId: modelSelection.requestedModelId } : {}),
            ...(persistedModelId && modelSelection.activeModelId
              ? { activeModelId: modelSelection.activeModelId }
              : {}),
            ...(modelSelection.selectionFallbackReason
              ? { modelSelectionFallbackReason: modelSelection.selectionFallbackReason }
              : {}),
            ...(assistant.fallbackReason
              ? { fallbackReason: assistant.fallbackReason }
              : {}),
            ...(assistant.fallbackDetail
              ? { fallbackDetail: assistant.fallbackDetail }
              : {})
          }
        });

        try {
          await reflectSession({
            env: this.env,
            sessionId,
            session,
            timestamp: new Date().toISOString()
          });
        } catch {
          // Keep the chat path stable if reflection persistence is unavailable.
        }

        return json({ assistant, session }, 201);
      } catch (error) {
        return handleRepositoryError(error);
      }
    }

    if (request.method === "POST" && url.pathname === "/tool-events") {
      const body = await request.json().catch(() => null);

      if (
        !isJsonObject(body) ||
        typeof body.toolName !== "string" ||
        typeof body.summary !== "string"
      ) {
        return json({ error: "toolName and summary are required" }, 400);
      }

      try {
        const session = await repository.appendToolEvent({
          timestamp: new Date().toISOString(),
          toolName: body.toolName,
          summary: body.summary,
          metadata: isJsonObject(body.metadata) ? body.metadata : undefined
        });

        return json({ session }, 201);
      } catch (error) {
        return handleRepositoryError(error);
      }
    }

    if (request.method === "GET" && url.pathname === "/recall") {
      const query = url.searchParams.get("q");

      if (!query) {
        return json({ error: "q is required" }, 400);
      }

      const session = await repository.getSession({
        asOf: parseOptionalInteger(url.searchParams.get("asOf"))
      });

      if (!session) {
        return json({ error: "session not initialized" }, 404);
      }

      const matches = await repository.recall({
        query,
        limit: parseOptionalInteger(url.searchParams.get("limit")) ?? 5,
        asOf: parseOptionalInteger(url.searchParams.get("asOf"))
      });

      return json({
        sessionId,
        query,
        asOf: parseOptionalInteger(url.searchParams.get("asOf")) ?? null,
        matches
      });
    }

    return json({ error: "not found" }, 404);
  }

  private getRepository(sessionId: string): SessionStateRepository {
    if (!this.repository || this.activeSessionId !== sessionId) {
      this.repository = mountAaronDbEdgeSessionRuntime(this.env, this.state, sessionId).repository;
      this.activeSessionId = sessionId;
    }

    return this.repository;
  }
}

function buildAssistantRoute(
  model:
    | {
        provider: "workers-ai" | "gemini";
        model: string;
      }
    | null,
  geminiApiKey: string | null
): AssistantProviderRoute | null {
  if (!model) {
    return null;
  }

  return model.provider === "gemini"
    ? {
        provider: "gemini",
        model: model.model,
        apiKey: geminiApiKey
      }
    : {
        provider: "workers-ai",
        model: model.model
      };
}

function buildFallbackAssistantRoute(
  modelSelection: {
    activeModel: { provider: "workers-ai" | "gemini"; model: string } | null;
    models: Array<{
      provider: "workers-ai" | "gemini";
      model: string;
      selectable: boolean;
    }>;
  },
  geminiApiKey: string | null
): AssistantProviderRoute | null {
  if (modelSelection.activeModel?.provider === "gemini") {
    const workersModel = modelSelection.models.find(
      (candidate) => candidate.provider === "workers-ai" && candidate.selectable
    );
    return workersModel ? { provider: "workers-ai", model: workersModel.model } : null;
  }

  const geminiModel = modelSelection.models.find(
    (candidate) => candidate.provider === "gemini" && candidate.selectable
  );
  return geminiModel
    ? {
        provider: "gemini",
        model: geminiModel.model,
        apiKey: geminiApiKey
      }
    : null;
}

function parseOptionalInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isMessageRole(value: unknown): value is MessageRole {
  return value === "user" || value === "assistant";
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function handleRepositoryError(error: unknown): Response {
  if (error instanceof Error && error.message === "session not initialized") {
    return json({ error: error.message }, 404);
  }

  return json({ error: "internal error" }, 500);
}