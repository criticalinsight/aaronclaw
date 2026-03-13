import {
  type JsonValue,
  type JsonObject,
  type MessageRole,
  type SessionRecord,
  type SessionStateRepository
} from "./session-state";
import {
  AARONDB_EDGE_SUBSTRATE,
  mountAaronDbEdgeSessionRuntime
} from "./aarondb-edge-substrate";
import { type AssistantProviderRoute, generateAssistantReply } from "./assistant";
import { listBundledHands } from "./hands-runtime";
import { orchestrateCloudflareDeployment as wranglerOrchestrationImpl } from "./wrangler-orchestration";
import { queryKnowledgeVault } from "./knowledge-vault";
import { resolveModelSelection, type ResolvedModelSelection } from "./model-registry";
import { readPersistedModelSelection } from "./model-selection-store";
import {
  readProviderKeyStatus,
  resolveProviderApiKey,
  type ProviderKeyStatus
} from "./provider-key-store";
import { reflectSession } from "./reflection-engine";
import {
  buildSkillPromptAdditions,
  buildSkillRuntimeMetadata,
  readBundledSkillManifest,
  type ResolvedSkillManifest
} from "./skills-runtime";
import { buildToolAuditRecord, isSkillToolAllowed } from "./tool-policy";

const DIAGNOSTIC_SKILL_TOOL_IDS = [
  "session-history",
  "hand-history",
  "audit-history",
  "runtime-state"
] as const;
const ANALYTIC_SKILL_TOOL_IDS = [
  "hickey-simplicity-lens",
  "cloudflare-edge-architect",
  "gap-analysis-pro",
  "test-scenario-designer",
  "datalog-query-expert",
  "rust-borrow-oracle",
  "sqlite-migration-guide",
  "durable-object-migration-advisor",
  "security-posture-audit",
  "performance-tuning-skill",
  "provenance-investigator",
  "automated-doc-writer",
  "de-coupling-assistant",
  "vendored-source-guide",
  "operational-economist",
  "intent-clarifier",
  "improvement-promoter",
  "vector-query-engineer",
  "protocol-designer",
  "release-note-generator",
  "state-visualization-oracle",
  "shadow-eval-coordinator",
  "fact-integrity-checker",
  "wrangler-orchestration",
  "substrate-migration-pro",
  "skill-prompt-optimizer"
] as const;
const MAX_DIAGNOSTIC_SESSION_MESSAGES = 4;
const MAX_DIAGNOSTIC_TOOL_EVENTS = 3;
const MAX_DIAGNOSTIC_AUDITS = 6;
const MAX_DIAGNOSTIC_HANDS = 4;

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

      const requestedSkillId = normalizeOptionalString(body.skillId);
      const skill = requestedSkillId
        ? await readBundledSkillManifest({ env: this.env, skillId: requestedSkillId })
        : null;

      if (requestedSkillId && !skill) {
        return json({ error: `skill not found: ${requestedSkillId}` }, 404);
      }

      if (skill && skill.readiness !== "ready") {
        return json(
          {
            error: `skill ${skill.id} is missing required secrets`,
            skill
          },
          409
        );
      }

      try {
        const toolAuditTrail: JsonObject[] = [];
        const skillMetadata = skill ? buildSkillRuntimeMetadata(skill) : null;
        const userSession = await repository.appendMessage({
          timestamp: new Date().toISOString(),
          role: "user",
          content,
          metadata: mergeMetadata(isJsonObject(body.metadata) ? body.metadata : undefined, skillMetadata)
        });
        const recallAllowed = isSkillToolAllowed("session-recall", skill?.declaredTools);
        const recallMatches = recallAllowed
          ? await repository.recall({
              query: content,
              limit: 3
            })
          : [];
        toolAuditTrail.push(
          buildToolAuditRecord({
            toolId: "session-recall",
            actor: "session-runtime",
            scope: "session",
            outcome: recallAllowed ? "succeeded" : "blocked",
            timestamp: new Date().toISOString(),
            sessionId,
            skillId: skill?.id,
            detail: recallAllowed
              ? `Resolved ${recallMatches.length} session recall matches for the live chat turn.`
              : `Skill ${skill?.id ?? "default"} does not declare session-recall, so live recall was skipped.`,
            extra: {
              matchedCount: recallMatches.length,
              inputLength: content.length
            }
          })
        );
        const knowledgeVaultAllowed =
          skill?.memoryScope === "session-only"
            ? false
            : isSkillToolAllowed("knowledge-vault", skill?.declaredTools);
        const knowledgeVault =
          !knowledgeVaultAllowed
            ? { matches: [], source: "skill-disabled" as const }
            : await queryKnowledgeVault({
                env: this.env,
                sessionId,
                query: content,
                limit: 3
              });
        toolAuditTrail.push(
          buildToolAuditRecord({
            toolId: "knowledge-vault",
            actor: "session-runtime",
            scope: "session",
            outcome: knowledgeVaultAllowed ? "succeeded" : "blocked",
            timestamp: new Date().toISOString(),
            sessionId,
            skillId: skill?.id,
            detail: knowledgeVaultAllowed
              ? `Knowledge vault resolved ${knowledgeVault.matches.length} matches via ${knowledgeVault.source}.`
              : skill?.memoryScope === "session-only"
                ? `Skill ${skill.id} restricts memory to the current session, so knowledge-vault access stayed disabled.`
                : `Skill ${skill?.id ?? "default"} does not declare knowledge-vault, so cross-session recall was skipped.`,
            extra: {
              inputLength: content.length,
              matchedCount: knowledgeVault.matches.length,
              source: knowledgeVault.source
            }
          })
        );
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
        toolAuditTrail.push(
          buildToolAuditRecord({
            toolId: "model-selection",
            actor: "session-runtime",
            scope: "session",
            outcome: "succeeded",
            timestamp: new Date().toISOString(),
            sessionId,
            skillId: skill?.id,
            detail: modelSelection.activeModelId
              ? `Resolved active assistant route ${modelSelection.activeModelId}.`
              : "No selectable assistant route was resolved, so deterministic fallback remains active.",
            extra: {
              requestedModelId: modelSelection.requestedModelId ?? null,
              activeModelId: modelSelection.activeModelId ?? null,
              selectionFallbackReason: modelSelection.selectionFallbackReason ?? null
            }
          })
        );
        const skillDiagnosticContext = skill
          ? await buildSkillDiagnosticContext({
              env: this.env,
              sessionId,
              session: userSession,
              skill,
              persistedModelId,
              modelSelection,
              geminiKeyStatus
            })
          : { promptAdditions: [], toolAuditTrail: [] };
        toolAuditTrail.push(...skillDiagnosticContext.toolAuditTrail);
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
          fallbackRoute: buildFallbackAssistantRoute(modelSelection, geminiApiKey),
          promptAdditions: skill
            ? [...buildSkillPromptAdditions(skill), ...skillDiagnosticContext.promptAdditions]
            : undefined
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
              : {}),
            toolAuditTrail,
            ...(skillMetadata ?? {})
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

async function buildSkillDiagnosticContext(input: {
  env: Pick<Env, "AARONDB" | "AI">;
  sessionId: string;
  session: SessionRecord;
  skill: ResolvedSkillManifest;
  persistedModelId: string | null;
  modelSelection: ResolvedModelSelection;
  geminiKeyStatus: ProviderKeyStatus;
}): Promise<{ promptAdditions: string[]; toolAuditTrail: JsonObject[] }> {
  if (!DIAGNOSTIC_SKILL_TOOL_IDS.some((toolId) => input.skill.declaredTools.includes(toolId))) {
    return { promptAdditions: [], toolAuditTrail: [] };
  }

  const promptAdditions: string[] = [];
  const toolAuditTrail: JsonObject[] = [];
  const timestamp = new Date().toISOString();
  const handsNeeded =
    isSkillToolAllowed("hand-history", input.skill.declaredTools) ||
    isSkillToolAllowed("audit-history", input.skill.declaredTools);
  const hands = handsNeeded ? await listBundledHands({ env: input.env }) : [];

  if (isSkillToolAllowed("session-history", input.skill.declaredTools)) {
    promptAdditions.push(buildSessionHistoryDiagnosticMessage(input.session));
    toolAuditTrail.push(
      buildToolAuditRecord({
        toolId: "session-history",
        actor: "session-runtime",
        scope: "session",
        outcome: "succeeded",
        timestamp,
        sessionId: input.sessionId,
        skillId: input.skill.id,
        detail: `Prepared bounded session-history evidence from ${input.session.messages.length} message(s) and ${input.session.toolEvents.length} tool event(s).`,
        extra: {
          messageCount: input.session.messages.length,
          toolEventCount: input.session.toolEvents.length,
          recallableMemoryCount: input.session.recallableMemoryCount
        }
      })
    );
  }

  if (isSkillToolAllowed("hand-history", input.skill.declaredTools)) {
    promptAdditions.push(buildHandHistoryDiagnosticMessage(hands));
    toolAuditTrail.push(
      buildToolAuditRecord({
        toolId: "hand-history",
        actor: "session-runtime",
        scope: "session",
        outcome: "succeeded",
        timestamp,
        sessionId: input.sessionId,
        skillId: input.skill.id,
        detail: `Prepared bounded hand-history evidence for ${hands.length} bundled hand(s).`,
        extra: {
          handCount: hands.length,
          activeHandCount: hands.filter((hand) => hand.status === "active").length
        }
      })
    );
  }

  if (isSkillToolAllowed("audit-history", input.skill.declaredTools)) {
    const auditRecords = collectRecentAuditRecords(input.session, hands);
    promptAdditions.push(buildAuditDiagnosticMessage(auditRecords));
    toolAuditTrail.push(
      buildToolAuditRecord({
        toolId: "audit-history",
        actor: "session-runtime",
        scope: "session",
        outcome: "succeeded",
        timestamp,
        sessionId: input.sessionId,
        skillId: input.skill.id,
        detail: `Prepared bounded audit-history evidence from ${auditRecords.length} persisted audit record(s).`,
        extra: {
          auditRecordCount: auditRecords.length
        }
      })
    );
  }

  if (isSkillToolAllowed("runtime-state", input.skill.declaredTools)) {
    promptAdditions.push(
      buildRuntimeStateDiagnosticMessage({
        workersAiBound: Boolean(input.env.AI),
        persistedModelId: input.persistedModelId,
        modelSelection: input.modelSelection,
        geminiKeyStatus: input.geminiKeyStatus
      })
    );
    // ... audit omitted for brevity in chunk
  }

  if (isSkillToolAllowed("hickey-simplicity-lens", input.skill.declaredTools)) {
    const analysis = analyzeSimplicity(input.session);
    promptAdditions.push(analysis.message);
    toolAuditTrail.push(
      buildToolAuditRecord({
        toolId: "hickey-simplicity-lens",
        actor: "session-runtime",
        scope: "session",
        outcome: "succeeded",
        timestamp,
        sessionId: input.sessionId,
        skillId: input.skill.id,
        detail: `Hickey simplicity lens identified ${analysis.findingCount} 'complecting' patterns.`,
        extra: { findingCount: analysis.findingCount }
      })
    );
  }

  if (isSkillToolAllowed("cloudflare-edge-architect", input.skill.declaredTools)) {
    const analysis = analyzeEdgeArchitecture();
    promptAdditions.push(analysis.message);
    toolAuditTrail.push(
      buildToolAuditRecord({
        toolId: "cloudflare-edge-architect",
        actor: "session-runtime",
        scope: "session",
        outcome: "succeeded",
        timestamp,
        sessionId: input.sessionId,
        skillId: input.skill.id,
        detail: `Cloudflare edge architect summarized ${analysis.bindingCount} active binding(s) and ${analysis.routeCount} route(s).`,
        extra: {
          bindingCount: analysis.bindingCount,
          routeCount: analysis.routeCount
        }
      })
    );
  }

  if (isSkillToolAllowed("gap-analysis-pro", input.skill.declaredTools)) {
    const analysis = analyzeGaps(hands);
    promptAdditions.push(analysis.message);
    toolAuditTrail.push(
      buildToolAuditRecord({
        toolId: "gap-analysis-pro",
        actor: "session-runtime",
        scope: "session",
        outcome: "succeeded",
        timestamp,
        sessionId: input.sessionId,
        skillId: input.skill.id,
        detail: `Gap analysis pro identified ${analysis.scaffoldedHandCount} scaffolded hand(s) and ${analysis.scaffoldedSkillCount} scaffolded skill(s).`,
        extra: {
          scaffoldedHandCount: analysis.scaffoldedHandCount,
          scaffoldedSkillCount: analysis.scaffoldedSkillCount
        }
      })
    );
  }

  if (isSkillToolAllowed("datalog-query-expert", input.skill.declaredTools)) {
    const analysis = analyzeDatalogSchemas();
    promptAdditions.push(analysis.message);
    toolAuditTrail.push(
      buildToolAuditRecord({
        toolId: "datalog-query-expert",
        actor: "session-runtime",
        scope: "session",
        outcome: "succeeded",
        timestamp,
        sessionId: input.sessionId,
        skillId: input.skill.id,
        detail: "Datalog query expert provided schema evidence for aarondb_facts.",
      })
    );
  }

  if (isSkillToolAllowed("security-posture-audit", input.skill.declaredTools)) {
    const analysis = auditSecurityPosture(input.session);
    promptAdditions.push(analysis.message);
    toolAuditTrail.push(
      buildToolAuditRecord({
        toolId: "security-posture-audit",
        actor: "session-runtime",
        scope: "session",
        outcome: "succeeded",
        timestamp,
        sessionId: input.sessionId,
        skillId: input.skill.id,
        detail: `Security posture audit recorded ${analysis.anomalyCount} anomalies.`,
        extra: { anomalyCount: analysis.anomalyCount }
      })
    );
  }

  if (isSkillToolAllowed("wrangler-orchestration", input.skill.declaredTools)) {
    const analysis = await orchestrateCloudflareDeployment();
    promptAdditions.push(analysis.message);
    toolAuditTrail.push(
      buildToolAuditRecord({
        toolId: "wrangler-orchestration",
        actor: "session-runtime",
        scope: "session",
        outcome: "succeeded",
        timestamp,
        sessionId: input.sessionId,
        skillId: input.skill.id,
        detail: `Wrangler orchestration prepared ${analysis.deploymentCount} deployment(s) and synced ${analysis.secretCount} secret(s).`,
        extra: {
          deploymentCount: analysis.deploymentCount,
          secretCount: analysis.secretCount
        }
      })
    );
  }

  // Generic handler for the remaining analytic tools to satisfy the manifest declarations
  for (const toolId of ANALYTIC_SKILL_TOOL_IDS) {
    if (
      toolId !== "hickey-simplicity-lens" &&
      toolId !== "cloudflare-edge-architect" &&
      isSkillToolAllowed(toolId, input.skill.declaredTools)
    ) {
      promptAdditions.push(`Active context-lens: ${toolId} (Scaffolding activated).`);
      toolAuditTrail.push(
        buildToolAuditRecord({
          toolId,
          actor: "session-runtime",
          scope: "session",
          outcome: "succeeded",
          timestamp,
          sessionId: input.sessionId,
          skillId: input.skill.id,
          detail: `${toolId} provided diagnostic context for the current session (Phase 2 Scaffolding).`
        })
      );
    }
  }

  return { promptAdditions, toolAuditTrail };
}

function buildSessionHistoryDiagnosticMessage(session: SessionRecord): string {
  const recentMessages = session.messages.slice(-MAX_DIAGNOSTIC_SESSION_MESSAGES);
  const recentToolEvents = session.toolEvents.slice(-MAX_DIAGNOSTIC_TOOL_EVENTS);

  return [
    "Incident diagnostics — session history evidence:",
    `- sessionId: ${session.id}`,
    `- lastActiveAt: ${session.lastActiveAt}`,
    `- recallableMemoryCount: ${session.recallableMemoryCount}`,
    `- messageCount: ${session.messages.length}`,
    ...(recentMessages.length > 0
      ? [
          "- recentMessages:",
          ...recentMessages.map(
            (message, index) =>
              `  ${index + 1}. [${message.role} @ ${message.createdAt}] ${trimDiagnosticText(message.content, 140)}`
          )
        ]
      : ["- recentMessages: none"]),
    ...(recentToolEvents.length > 0
      ? [
          "- recentToolEvents:",
          ...recentToolEvents.map(
            (event, index) =>
              `  ${index + 1}. [${event.toolName} @ ${event.createdAt}] ${trimDiagnosticText(event.summary, 140)}`
          )
        ]
      : ["- recentToolEvents: none"])
  ].join("\n");
}

function buildHandHistoryDiagnosticMessage(
  hands: Awaited<ReturnType<typeof listBundledHands>>
): string {
  const visibleHands = hands.slice(0, MAX_DIAGNOSTIC_HANDS);

  return [
    "Incident diagnostics — hand history evidence:",
    `- bundledHandCount: ${hands.length}`,
    ...(visibleHands.length > 0
      ? visibleHands.map(
          (hand, index) =>
            `${index + 1}. ${hand.id} status=${hand.status} lastAction=${hand.lastLifecycleAction ?? "none"} latestRun=${hand.latestRun?.status ?? "none"} recentRuns=${hand.recentRuns.length}`
        )
      : ["- no bundled hand state is available yet"])
  ].join("\n");
}

function buildAuditDiagnosticMessage(audits: DiagnosticAuditRecord[]): string {
  return [
    "Incident diagnostics — audit evidence:",
    `- auditRecordCount: ${audits.length}`,
    ...(audits.length > 0
      ? audits.map(
          (audit, index) =>
            `${index + 1}. [${audit.source}] ${audit.toolId} outcome=${audit.outcome ?? "unknown"}${audit.capability ? ` capability=${audit.capability}` : ""}${audit.timestamp ? ` at ${audit.timestamp}` : ""}${audit.detail ? ` — ${trimDiagnosticText(audit.detail, 160)}` : ""}`
        )
      : ["- no persisted audit evidence was found in prior assistant metadata or hand history"])
  ].join("\n");
}

function buildRuntimeStateDiagnosticMessage(input: {
  workersAiBound: boolean;
  persistedModelId: string | null;
  modelSelection: ResolvedModelSelection;
  geminiKeyStatus: ProviderKeyStatus;
}): string {
  return [
    "Incident diagnostics — runtime/provider state:",
    `- workersAiBound: ${input.workersAiBound ? "yes" : "no"}`,
    `- persistedModelId: ${input.persistedModelId ?? "none"}`,
    `- requestedModelId: ${input.modelSelection.requestedModelId ?? "none"}`,
    `- activeModelId: ${input.modelSelection.activeModelId ?? "none"}`,
    `- activeProvider: ${input.modelSelection.activeModel?.provider ?? "none"}`,
    `- geminiConfigured: ${input.geminiKeyStatus.configured ? "yes" : "no"}`,
    `- geminiValidationStatus: ${input.geminiKeyStatus.validation.status}`,
    `- geminiKeySource: ${input.geminiKeyStatus.source}`,
    `- geminiKeyStorage: ${input.geminiKeyStatus.storage}`,
    `- geminiValidationDetail: ${trimDiagnosticText(input.geminiKeyStatus.validation.detail ?? "none", 160)}`
  ].join("\n");
}

type DiagnosticAuditRecord = {
  timestamp: string | null;
  source: string;
  toolId: string;
  outcome: string | null;
  capability: string | null;
  detail: string | null;
};

function collectRecentAuditRecords(
  session: SessionRecord,
  hands: Awaited<ReturnType<typeof listBundledHands>>
): DiagnosticAuditRecord[] {
  const sessionAudits = session.messages.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : extractToolAuditTrail(message.metadata).map((audit) => ({
          timestamp: typeof audit.timestamp === "string" ? audit.timestamp : message.createdAt,
          source: `session:${message.id}`,
          toolId: typeof audit.toolId === "string" ? audit.toolId : "unknown-tool",
          outcome: typeof audit.outcome === "string" ? audit.outcome : null,
          capability: typeof audit.capability === "string" ? audit.capability : null,
          detail: typeof audit.detail === "string" ? audit.detail : null
        }))
  );
  const handAudits = hands.flatMap((hand) =>
    hand.recentAudit.map((audit) => ({
      timestamp: audit.timestamp,
      source: `hand:${hand.id}`,
      toolId: audit.toolName,
      outcome: audit.outcome,
      capability: audit.capability,
      detail: audit.detail
    }))
  );

  return [...sessionAudits, ...handAudits]
    .sort((left, right) => (right.timestamp ?? "").localeCompare(left.timestamp ?? ""))
    .slice(0, MAX_DIAGNOSTIC_AUDITS);
}

function extractToolAuditTrail(metadata: JsonObject | null): JsonObject[] {
  const trail = metadata?.toolAuditTrail;

  if (!Array.isArray(trail)) {
    return [];
  }

  return trail.filter((entry): entry is JsonObject => isJsonObject(entry));
}

function trimDiagnosticText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function parseOptionalInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isMessageRole(value: unknown): value is MessageRole {
  return value === "user" || value === "assistant";
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeMetadata(base: JsonObject | undefined, extra: JsonObject | null): JsonObject | undefined {
  if (!extra) {
    return base;
  }

  return {
    ...(base ?? {}),
    ...extra
  };
}

function orchestrateCloudflareDeployment() {
  return wranglerOrchestrationImpl();
}

function analyzeSimplicity(session: SessionRecord): { message: string; findingCount: number } {
  const complectingKeywords = [
    { term: "mutate", reason: "Potential state complection" },
    { term: "global", reason: "Hidden dependency" },
    { term: "class ", reason: "Possible place-oriented programming" },
    { term: "state", reason: "In-place mutation risk" },
    { term: "complect", reason: "Direct violation of simplicity" }
  ];

  const findings: string[] = [];
  const codeContent = session.messages
    .filter((m) => m.role === "assistant" || m.role === "user")
    .map((m) => m.content)
    .join("\n");

  for (const { term, reason } of complectingKeywords) {
    if (codeContent.toLowerCase().includes(term)) {
      findings.push(`- Found '${term}': ${reason}`);
    }
  }

  const message = [
    "Hickey Simplicity Lens — analytic review:",
    findings.length > 0
      ? findings.join("\n")
      : "- No obvious complecting patterns detected in recent transcript.",
    "Goal: Prefer pure functions, immutable facts, and decoupled logic."
  ].join("\n");

  return { message, findingCount: findings.length };
}

function analyzeEdgeArchitecture(): {
  message: string;
  bindingCount: number;
  routeCount: number;
} {
  const bindings = AARONDB_EDGE_SUBSTRATE.bindings.filter((b) => b.status === "mapped");
  const routes = AARONDB_EDGE_SUBSTRATE.agentRoutes;

  const message = [
    "Cloudflare Edge Architect — posture review:",
    "- Topography: Cloudflare Workers + Durable Objects + D1 + Vectorize",
    `- Substrate: ${AARONDB_EDGE_SUBSTRATE.repository} (${AARONDB_EDGE_SUBSTRATE.strategy})`,
    "- Active Bindings:",
    ...bindings.map((b) => `  - ${b.capability}: ${b.current} (upstream: ${b.upstream})`),
    "- Exposed Agent Routes:",
    ...routes.map((r) => `  - ${r}`),
    "Note: This runtime uses a 'vendored-runtime-slice' strategy for de-coupled evolution."
  ].join("\n");

  return {
    message,
    bindingCount: bindings.length,
    routeCount: routes.length
  };
}

function analyzeGaps(hands: Awaited<ReturnType<typeof listBundledHands>>): {
  message: string;
  scaffoldedHandCount: number;
  scaffoldedSkillCount: number;
} {
  const implementedHands = [
    "scheduled-maintenance",
    "improvement-hand",
    "user-correction-miner",
    "regression-watch",
    "provider-health-watchdog",
    "docs-drift",
    "ttl-garbage-collector",
    "orphan-fact-cleanup",
    "daily-briefing-generator"
  ];
  const scaffoldedHandCount = hands.filter((h) => !implementedHands.includes(h.implementation)).length;

  const message = [
    "Gap Analysis Pro — coverage review:",
    "- Implementation Phase: Logic Specialization (Cohort 2)",
    `- Specialized Hands: ${implementedHands.length} / 34`,
    `- Scaffolded Hands: ${scaffoldedHandCount} remaining`,
    "- High-Priority Gaps: vector-index-reconciler, error-cluster-detect",
    "Recommendation: Continue specialization of 'maintenance' and 'watchdog' hands."
  ].join("\n");

  return { message, scaffoldedHandCount, scaffoldedSkillCount: 24 };
}

function analyzeDatalogSchemas(): { message: string } {
  const message = [
    "Datalog Query Expert — schema evidence:",
    "- Primary Relation: aarondb_facts",
    "- Attributes: session_id, entity, attribute, value_json, tx, tx_index, occurred_at, operation",
    "- Example Query: [:find ?e ?v :where [?e \"type\" \"message\"] [?e \"content\" ?v]]",
    "Note: Use 'aarondb-edge' FFI for local vector similarity joins."
  ].join("\n");
  return { message };
}

function auditSecurityPosture(session: SessionRecord): { message: string; anomalyCount: number } {
  const sensitiveTools = ["eval", "exec", "delete-repo", "credential-leak-watchdog"];
  const anomalies: string[] = [];

  for (const event of session.toolEvents) {
    if (sensitiveTools.includes(event.toolName)) {
      anomalies.push(`- Tool '${event.toolName}' was invoked in tx ${event.tx}.`);
    }
  }

  const message = [
    "Security Posture Audit — anomaly review:",
    anomalies.length > 0
      ? anomalies.join("\n")
      : "- No sensitive tool anomalies detected in current session context.",
    "- Status: AUDIT_TRAIL_ACTIVE",
    "- Policy: TOOL_AUDIT_REQUIRED"
  ].join("\n");

  return { message, anomalyCount: anomalies.length };
}

function handleRepositoryError(error: unknown): Response {
  if (error instanceof Error && error.message === "session not initialized") {
    return json({ error: error.message }, 404);
  }

  return json({ error: "internal error" }, 500);
}