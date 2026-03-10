import {
  AaronDbEdgeSessionRepository,
  type JsonObject,
  type MessageEvent,
  type SessionRecord,
  type ToolEvent
} from "./session-state";
import { buildToolAuditRecord } from "./tool-policy";

const ALL_FACTS_SQL = `
  SELECT session_id, entity, attribute, value_json, tx, tx_index, occurred_at, operation
  FROM aarondb_facts
  WHERE session_id != ?
  ORDER BY session_id ASC, tx ASC, tx_index ASC
`;

const REFLECTION_PREFIX = "reflection:";
const MAINTENANCE_PREFIX = "maintenance:";
const HAND_PREFIX = "hand:";
const IMPROVEMENT_PREFIX = "improvement:";
const IMPROVEMENT_PROPOSAL_SESSION_ID = `${IMPROVEMENT_PREFIX}proposals`;
const MAINTENANCE_CRON = "*/30 * * * *";
const MORNING_BRIEFING_CRON = "0 8 * * *";
const MAX_MAINTENANCE_SESSIONS = 5;
const SIGNAL_TERMS = [
  "because",
  "evidence",
  "inspect",
  "proof",
  "reason",
  "search",
  "step",
  "therefore",
  "verify"
];

interface FactRow {
  session_id: string;
  occurred_at: string;
}

type ImprovementRiskLevel = "low" | "medium" | "high";
type ImprovementVerificationStatus = "pending" | "verified" | "not-needed";

interface ImprovementEvidenceRecord extends JsonObject {
  kind: "audit" | "message" | "tool-event" | "metric";
  summary: string;
  eventId: string | null;
  tx: number | null;
  excerpt: string | null;
}

interface ImprovementRiskRecord extends JsonObject {
  level: ImprovementRiskLevel;
  summary: string;
}

interface ImprovementVerificationRecord extends JsonObject {
  status: ImprovementVerificationStatus;
  summary: string;
}

export interface ImprovementSignalRecord extends JsonObject {
  signalKey: string;
  category: "evidence" | "follow-up" | "verification";
  status: "active";
  summary: string;
  evidence: ImprovementEvidenceRecord[];
  risk: ImprovementRiskRecord;
  verification: ImprovementVerificationRecord;
}

export interface ImprovementCandidateRecord extends JsonObject {
  candidateKey: string;
  status: "proposed";
  summary: string;
  problemStatement: string;
  proposedAction: string;
  expectedBenefit: string;
  riskLevel: ImprovementRiskLevel;
  verificationPlan: string;
  derivedFromSignalKeys: string[];
  evidence: ImprovementEvidenceRecord[];
  risk: ImprovementRiskRecord;
  verification: ImprovementVerificationRecord;
}

export interface ImprovementProposalRecord extends ImprovementCandidateRecord {
  proposalKey: string;
  sourceReflectionSessionId: string;
  sourceSessionId: string;
  sourceLastTx: number;
}

export interface SessionReflectionResult {
  sessionId: string;
  reflectionSessionId: string;
  summary: string;
  persisted: boolean;
  sourceLastTx: number;
  improvementSignalCount: number;
  improvementCandidateCount: number;
}

export interface ScheduledMaintenanceResult {
  cron: string;
  maintenanceSessionId: string;
  reviewedSessionIds: string[];
  reflectedSessionIds: string[];
}

export interface ImprovementProposalReviewResult {
  cron: string;
  proposalSessionId: string;
  reviewedReflectionSessionIds: string[];
  reviewedSignalCount: number;
  generatedProposalCount: number;
  skippedDuplicateProposalCount: number;
}

export async function reflectSession(input: {
  env: Pick<Env, "AARONDB">;
  sessionId: string;
  session?: SessionRecord | null;
  timestamp?: string;
}): Promise<SessionReflectionResult> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const sourceSession =
    input.session ??
    (await new AaronDbEdgeSessionRepository(input.env.AARONDB, input.sessionId).getSession());
  const reflectionSessionId = `${REFLECTION_PREFIX}${input.sessionId}`;

  if (!sourceSession || sourceSession.events.length === 0) {
    return {
      sessionId: input.sessionId,
      reflectionSessionId,
      summary: "No session activity was available for reflection.",
      persisted: false,
      sourceLastTx: 0,
      improvementSignalCount: 0,
      improvementCandidateCount: 0
    };
  }

  const reflectionRepository = new AaronDbEdgeSessionRepository(
    input.env.AARONDB,
    reflectionSessionId
  );
  const reflectionSession = await ensureSyntheticSession(reflectionRepository, timestamp);
  const latestReflectedTx = getLatestReflectedTx(reflectionSession.toolEvents);

  if (latestReflectedTx >= sourceSession.lastTx) {
    return {
      sessionId: input.sessionId,
      reflectionSessionId,
      summary: "Reflection was already up to date for this session.",
      persisted: false,
      sourceLastTx: sourceSession.lastTx,
      improvementSignalCount: 0,
      improvementCandidateCount: 0
    };
  }

  const metrics = analyzeSession(sourceSession);
  const improvementSignals = buildImprovementSignals(sourceSession, metrics);
  const improvementCandidates = buildImprovementCandidates(improvementSignals);
  const summary = buildReflectionSummary(sourceSession, metrics);

  await reflectionRepository.appendToolEvent({
    timestamp,
    toolName: "session-reflection",
    summary,
    metadata: {
      assistantMessageCount: metrics.assistantMessageCount,
      proofSignalCount: metrics.proofSignalCount,
      reasoningSignalCount: metrics.reasoningSignalCount,
      reflectionFor: input.sessionId,
      sourceLastTx: sourceSession.lastTx,
      toolEventCount: metrics.toolEventCount,
      unresolvedPromptCount: metrics.unresolvedPromptCount,
      improvementSignalCount: improvementSignals.length,
      improvementCandidateCount: improvementCandidates.length,
      improvementSignals,
      improvementCandidates,
      audit: buildToolAuditRecord({
        toolId: "session-reflection",
        actor: "maintenance-runtime",
        scope: "maintenance",
        outcome: "succeeded",
        timestamp,
        sessionId: input.sessionId,
        detail: `Reflection captured source tx ${sourceSession.lastTx}.`,
        extra: {
          reflectionSessionId,
          sourceLastTx: sourceSession.lastTx,
          toolEventCount: metrics.toolEventCount
        }
      })
    }
  });

  return {
    sessionId: input.sessionId,
    reflectionSessionId,
    summary,
    persisted: true,
    sourceLastTx: sourceSession.lastTx,
    improvementSignalCount: improvementSignals.length,
    improvementCandidateCount: improvementCandidates.length
  };
}

export async function runScheduledMaintenance(input: {
  env: Pick<Env, "AARONDB">;
  cron: string;
  timestamp?: string;
}): Promise<ScheduledMaintenanceResult> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const reviewedSessionIds = await listRecentSessionIds(input.env.AARONDB, MAX_MAINTENANCE_SESSIONS);
  const reflections = await Promise.all(
    reviewedSessionIds.map((sessionId) => reflectSession({ env: input.env, sessionId, timestamp }))
  );
  const maintenanceSessionId = buildMaintenanceSessionId(input.cron, timestamp);
  const maintenanceRepository = new AaronDbEdgeSessionRepository(
    input.env.AARONDB,
    maintenanceSessionId
  );

  await ensureSyntheticSession(maintenanceRepository, timestamp);
  await maintenanceRepository.appendToolEvent({
    timestamp,
    toolName: input.cron === MORNING_BRIEFING_CRON ? "morning-briefing" : "scheduled-maintenance",
    summary: buildMaintenanceSummary(input.cron, reflections),
    metadata: {
      cron: input.cron,
      reflectedSessionCount: reflections.filter((reflection) => reflection.persisted).length,
      reviewedSessionCount: reviewedSessionIds.length,
      reviewedSessionIds,
      audit: buildToolAuditRecord({
        toolId: input.cron === MORNING_BRIEFING_CRON ? "morning-briefing" : "scheduled-maintenance",
        actor: "maintenance-runtime",
        scope: "maintenance",
        outcome: "succeeded",
        timestamp,
        sessionId: maintenanceSessionId,
        detail: `Maintenance reviewed ${reviewedSessionIds.length} sessions for cron ${input.cron}.`,
        extra: {
          cron: input.cron,
          reflectedSessionCount: reflections.filter((reflection) => reflection.persisted).length,
          reviewedSessionCount: reviewedSessionIds.length
        }
      })
    }
  });

  return {
    cron: input.cron,
    maintenanceSessionId,
    reviewedSessionIds,
    reflectedSessionIds: reflections
      .filter((reflection) => reflection.persisted)
      .map((reflection) => reflection.sessionId)
  };
}

export async function runScheduledImprovementProposalReview(input: {
  env: Pick<Env, "AARONDB">;
  cron: string;
  timestamp?: string;
}): Promise<ImprovementProposalReviewResult> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const reviewedReflectionSessionIds = await listRecentReflectionSessionIds(
    input.env.AARONDB,
    MAX_MAINTENANCE_SESSIONS
  );
  const storedReflections = (
    await Promise.all(
      reviewedReflectionSessionIds.map((reflectionSessionId) =>
        readStoredReflectionArtifact(input.env.AARONDB, reflectionSessionId)
      )
    )
  ).filter((artifact): artifact is StoredReflectionArtifact => artifact !== null);
  const reviewedSignalCount = storedReflections.reduce(
    (total, artifact) => total + artifact.improvementSignals.length,
    0
  );
  const proposalMap = new Map<string, ImprovementProposalRecord>();

  for (const artifact of storedReflections) {
    for (const proposal of buildImprovementProposals(artifact)) {
      if (!proposalMap.has(proposal.proposalKey)) {
        proposalMap.set(proposal.proposalKey, proposal);
      }
    }
  }

  const allProposals = [...proposalMap.values()];
  const proposalRepository = new AaronDbEdgeSessionRepository(
    input.env.AARONDB,
    IMPROVEMENT_PROPOSAL_SESSION_ID
  );
  const existingProposalKeys = getStoredProposalKeys((await proposalRepository.getSession())?.toolEvents ?? []);
  const freshProposals = allProposals.filter((proposal) => !existingProposalKeys.has(proposal.proposalKey));

  if (freshProposals.length > 0) {
    await ensureSyntheticSession(proposalRepository, timestamp);
    await proposalRepository.appendToolEvent({
      timestamp,
      toolName: "improvement-proposal-review",
      summary: `Improvement Hand reviewed ${storedReflections.length} reflection session(s) and wrote ${freshProposals.length} structured proposal(s).`,
      metadata: {
        cron: input.cron,
        generatedProposalCount: freshProposals.length,
        proposals: freshProposals,
        reviewedReflectionCount: storedReflections.length,
        reviewedReflectionSessionIds: storedReflections.map((artifact) => artifact.reflectionSessionId),
        reviewedSignalCount,
        skippedDuplicateProposalCount: allProposals.length - freshProposals.length,
        audit: buildToolAuditRecord({
          toolId: "improvement-proposal-review",
          actor: "hand-runtime",
          scope: "hand",
          outcome: "succeeded",
          timestamp,
          handId: "improvement-hand",
          sessionId: IMPROVEMENT_PROPOSAL_SESSION_ID,
          detail: `Improvement Hand wrote ${freshProposals.length} structured proposal(s) from ${storedReflections.length} stored reflection session(s).`,
          extra: {
            cron: input.cron,
            generatedProposalCount: freshProposals.length,
            reviewedReflectionCount: storedReflections.length,
            reviewedSignalCount,
            skippedDuplicateProposalCount: allProposals.length - freshProposals.length
          }
        })
      }
    });
  }

  return {
    cron: input.cron,
    proposalSessionId: IMPROVEMENT_PROPOSAL_SESSION_ID,
    reviewedReflectionSessionIds: storedReflections.map((artifact) => artifact.reflectionSessionId),
    reviewedSignalCount,
    generatedProposalCount: freshProposals.length,
    skippedDuplicateProposalCount: allProposals.length - freshProposals.length
  };
}

interface StoredReflectionArtifact {
  reflectionSessionId: string;
  sourceSessionId: string;
  sourceLastTx: number;
  improvementSignals: ImprovementSignalRecord[];
}

async function listRecentSessionIds(database: D1Database, limit: number): Promise<string[]> {
  const result = await database.prepare(ALL_FACTS_SQL).bind("__none__").all<FactRow>();
  const latestBySessionId = new Map<string, string>();

  for (const row of result.results ?? []) {
    if (isSyntheticSessionId(row.session_id)) {
      continue;
    }

    const current = latestBySessionId.get(row.session_id);
    if (!current || row.occurred_at > current) {
      latestBySessionId.set(row.session_id, row.occurred_at);
    }
  }

  return [...latestBySessionId.entries()]
    .sort((left, right) => right[1].localeCompare(left[1]))
    .slice(0, limit)
    .map(([sessionId]) => sessionId);
}

async function listRecentReflectionSessionIds(database: D1Database, limit: number): Promise<string[]> {
  const result = await database.prepare(ALL_FACTS_SQL).bind("__none__").all<FactRow>();
  const latestBySessionId = new Map<string, string>();

  for (const row of result.results ?? []) {
    if (!row.session_id.startsWith(REFLECTION_PREFIX)) {
      continue;
    }

    const current = latestBySessionId.get(row.session_id);
    if (!current || row.occurred_at > current) {
      latestBySessionId.set(row.session_id, row.occurred_at);
    }
  }

  return [...latestBySessionId.entries()]
    .sort((left, right) => right[1].localeCompare(left[1]))
    .slice(0, limit)
    .map(([sessionId]) => sessionId);
}

async function ensureSyntheticSession(
  repository: AaronDbEdgeSessionRepository,
  timestamp: string
): Promise<SessionRecord> {
  return (await repository.getSession()) ?? repository.createSession(timestamp);
}

function getLatestReflectedTx(events: ToolEvent[]): number {
  return events.reduce((latest, event) => {
    const sourceLastTx = event.metadata?.sourceLastTx;
    return typeof sourceLastTx === "number" ? Math.max(latest, sourceLastTx) : latest;
  }, 0);
}

function analyzeSession(session: SessionRecord) {
  const userMessages = session.messages.filter((message) => message.role === "user");
  const assistantMessages = session.messages.filter((message) => message.role === "assistant");
  const signalTerms = tokenize(session.events.map((event) => previewEvent(event)).join(" "));

  return {
    assistantMessageCount: assistantMessages.length,
    proofSignalCount: signalTerms.filter(
      (term) => term === "proof" || term === "verify" || term === "evidence"
    ).length,
    reasoningSignalCount: signalTerms.filter((term) => SIGNAL_TERMS.includes(term)).length,
    toolEventCount: session.toolEvents.length,
    unresolvedPromptCount: userMessages.filter((message) => message.content.includes("?")).length
  };
}

function buildImprovementSignals(
  session: SessionRecord,
  metrics: ReturnType<typeof analyzeSession>
): ImprovementSignalRecord[] {
  const assistantMessages = session.messages.filter((message) => message.role === "assistant");
  const latestUserMessage = [...session.messages].reverse().find((message) => message.role === "user");
  const latestQuestion = [...session.messages]
    .reverse()
    .find((message) => message.role === "user" && message.content.includes("?"));
  const latestToolEvent = [...session.toolEvents].reverse()[0] ?? null;
  const degradedAudits = assistantMessages.flatMap((message) =>
    extractToolAuditTrail(message.metadata)
      .filter((audit) => {
        const outcome = typeof audit.outcome === "string" ? audit.outcome : null;
        return outcome === "blocked" || outcome === "failed";
      })
      .map((audit) => ({ audit, message }))
  );
  const fallbackMessages = assistantMessages.filter(
    (message) => typeof message.metadata?.fallbackReason === "string"
  );
  const signals: ImprovementSignalRecord[] = [];

  if (metrics.proofSignalCount > 0 && metrics.toolEventCount === 0) {
    signals.push({
      signalKey: "evidence-intent-without-tool-trace",
      category: "verification",
      status: "active",
      summary: "The session asked for proof or evidence without recording a supporting tool trace.",
      evidence: [
        buildMetricEvidence(
          `proofSignalCount=${metrics.proofSignalCount} while toolEventCount=${metrics.toolEventCount}.`
        ),
        ...(latestUserMessage ? [buildMessageEvidence(latestUserMessage, "Latest user request asked for evidence.")] : [])
      ],
      risk: {
        level: "high",
        summary: "Future answers can look verified even though the fact log lacks an explicit evidence trail."
      },
      verification: {
        status: "pending",
        summary: "Verify a later run records at least one supporting tool event or explicitly marks the answer as unverified."
      }
    });
  }

  if (metrics.unresolvedPromptCount > 0 && latestQuestion) {
    signals.push({
      signalKey: "open-user-questions",
      category: "follow-up",
      status: "active",
      summary: "The session still contains user questions that should receive an explicit follow-up or closure step.",
      evidence: [
        buildMetricEvidence(`unresolvedPromptCount=${metrics.unresolvedPromptCount}.`),
        buildMessageEvidence(latestQuestion, "Latest unresolved user question is still present in the session log.")
      ],
      risk: {
        level: "medium",
        summary: "Open questions can accumulate and degrade trust if the runtime never closes the loop."
      },
      verification: {
        status: "pending",
        summary: "Verify a future assistant turn answers the question directly or stores an explicit deferred status."
      }
    });
  }

  if (metrics.proofSignalCount > 0 && metrics.toolEventCount > 0 && latestToolEvent) {
    signals.push({
      signalKey: "evidence-backed-reasoning-present",
      category: "evidence",
      status: "active",
      summary: "The session paired evidence-seeking language with a persisted tool trace that future foundation work can reuse.",
      evidence: [
        buildMetricEvidence(
          `proofSignalCount=${metrics.proofSignalCount} with toolEventCount=${metrics.toolEventCount}.`
        ),
        buildToolEventEvidence(latestToolEvent, "Latest tool event provides a persisted evidence trail.")
      ],
      risk: {
        level: "low",
        summary: "This is a promising pattern, but it still needs a reusable verification contract before broader automation depends on it."
      },
      verification: {
        status: "verified",
        summary: "Verified for this snapshot because the fact log already contains a supporting tool event."
      }
    });
  }

  if (degradedAudits.length > 0) {
    const latestDegradedAudit = degradedAudits[degradedAudits.length - 1];
    signals.push({
      signalKey: "degraded-tool-audit",
      category: "verification",
      status: "active",
      summary: "The session recorded blocked or failed tool audits that should feed an improvement candidate.",
      evidence: [
        buildMetricEvidence(`degradedToolAuditCount=${degradedAudits.length}.`),
        buildMessageEvidence(
          latestDegradedAudit.message,
          "Assistant metadata persisted a blocked or failed tool audit on this turn."
        ),
        buildAuditEvidence(latestDegradedAudit.audit)
      ],
      risk: {
        level: degradedAudits.some(({ audit }) => audit.outcome === "failed") ? "high" : "medium",
        summary: "Degraded tool paths can silently reduce capability unless later waves make the failure mode operator-visible."
      },
      verification: {
        status: "pending",
        summary: "Verify later runs either recover the affected tool path or persist an explicit operator-facing degraded status."
      }
    });
  }

  if (fallbackMessages.length > 0) {
    const latestFallbackMessage = fallbackMessages[fallbackMessages.length - 1];
    const fallbackReason = String(latestFallbackMessage.metadata?.fallbackReason);
    signals.push({
      signalKey: "assistant-fallback-observed",
      category: "verification",
      status: "active",
      summary: "The session used the deterministic fallback path instead of the preferred assistant route.",
      evidence: [
        buildMetricEvidence(`fallbackMessageCount=${fallbackMessages.length}.`),
        buildMessageEvidence(latestFallbackMessage, "Assistant response metadata recorded a fallback reason."),
        buildMetricEvidence(`fallbackReason=${fallbackReason}.`)
      ],
      risk: {
        level: "medium",
        summary: "Repeated fallback use can hide route instability and reduce confidence in persisted improvement evidence."
      },
      verification: {
        status: "pending",
        summary: "Verify the preferred route recovers or later waves persist a stable fallback-frequency metric and operator guidance."
      }
    });
  }

  return signals;
}

function buildImprovementCandidates(
  signals: ImprovementSignalRecord[]
): ImprovementCandidateRecord[] {
  return signals.map((signal) => {
    switch (signal.signalKey) {
      case "evidence-intent-without-tool-trace":
        return {
          candidateKey: "add-tool-backed-verification-step",
          status: "proposed",
          summary: "Add a tool-backed verification checkpoint before final answers when the turn asks for proof or evidence.",
          problemStatement: signal.summary,
          proposedAction:
            "Add a tool-backed verification checkpoint before final answers when the turn asks for proof or evidence.",
          expectedBenefit: "Makes proof-oriented answers more trustworthy by persisting an explicit evidence trail.",
          riskLevel: "medium",
          verificationPlan:
            "Verify future runs persist a tool trace and reduce recurrence of this signal for similar prompts.",
          derivedFromSignalKeys: [signal.signalKey],
          evidence: signal.evidence,
          risk: {
            level: "medium",
            summary: "Adding a verification checkpoint increases latency slightly, but it lowers the chance of unsupported reasoning."
          },
          verification: {
            status: "pending",
            summary: "Verify future runs persist a tool trace and reduce recurrence of this signal for similar prompts."
          }
        };
      case "open-user-questions":
        return {
          candidateKey: "add-explicit-follow-up-closure",
          status: "proposed",
          summary: "Add an explicit closure or deferred-follow-up marker when a user question remains unresolved in session history.",
          problemStatement: signal.summary,
          proposedAction:
            "Add an explicit closure or deferred-follow-up marker when a user question remains unresolved in session history.",
          expectedBenefit: "Prevents unresolved questions from silently accumulating and degrading operator trust.",
          riskLevel: "low",
          verificationPlan:
            "Verify later automation can distinguish resolved, deferred, and still-open questions from persisted metadata.",
          derivedFromSignalKeys: [signal.signalKey],
          evidence: signal.evidence,
          risk: {
            level: "low",
            summary: "Closure metadata is low risk, but it needs a consistent status vocabulary before broader automation reads it."
          },
          verification: {
            status: "pending",
            summary: "Verify later automation can distinguish resolved, deferred, and still-open questions from persisted metadata."
          }
        };
      case "degraded-tool-audit":
        return {
          candidateKey: "stabilize-degraded-tool-path",
          status: "proposed",
          summary: "Stabilize or clearly gate the degraded tool path surfaced by persisted audit failures.",
          problemStatement: signal.summary,
          proposedAction: "Stabilize or clearly gate the degraded tool path surfaced by persisted audit failures.",
          expectedBenefit: "Makes degraded tool behavior explicit and lowers the chance of hidden runtime erosion.",
          riskLevel: "medium",
          verificationPlan:
            "Verify later runs either remove the degraded audit or intentionally preserve it with an explicit blocked policy reason.",
          derivedFromSignalKeys: [signal.signalKey],
          evidence: signal.evidence,
          risk: {
            level: "medium",
            summary: "Repairing a degraded tool path may touch capability gates, so verification should stay narrow and operator-visible."
          },
          verification: {
            status: "pending",
            summary: "Verify later runs either remove the degraded audit or intentionally preserve it with an explicit blocked policy reason."
          }
        };
      case "assistant-fallback-observed":
        return {
          candidateKey: "track-and-reduce-fallback-frequency",
          status: "proposed",
          summary: "Track fallback frequency and reduce avoidable fallback use on the preferred assistant route.",
          problemStatement: signal.summary,
          proposedAction: "Track fallback frequency and reduce avoidable fallback use on the preferred assistant route.",
          expectedBenefit: "Improves confidence in the preferred assistant path while preserving deterministic fallback continuity.",
          riskLevel: "medium",
          verificationPlan:
            "Verify the preferred route succeeds on later runs without regressing deterministic fallback continuity.",
          derivedFromSignalKeys: [signal.signalKey],
          evidence: signal.evidence,
          risk: {
            level: "medium",
            summary: "Route recovery work can destabilize the happy path unless it stays additive and preserves deterministic fallback behavior."
          },
          verification: {
            status: "pending",
            summary: "Verify the preferred route succeeds on later runs without regressing deterministic fallback continuity."
          }
        };
      default:
        return {
          candidateKey: "promote-evidence-backed-pattern",
          status: "proposed",
          summary: "Promote the current evidence-backed reasoning pattern into a reusable skill/maintenance prompt contract.",
          problemStatement: signal.summary,
          proposedAction:
            "Promote the current evidence-backed reasoning pattern into a reusable skill/maintenance prompt contract.",
          expectedBenefit: "Captures a successful evidence-backed behavior in a reusable form without mutating live production behavior directly.",
          riskLevel: "low",
          verificationPlan:
            "Verify the promoted contract still preserves the existing chat, hands, and Telegram behavior when idle.",
          derivedFromSignalKeys: [signal.signalKey],
          evidence: signal.evidence,
          risk: {
            level: "low",
            summary: "Standardizing a good pattern is low risk if future waves preserve the current chat and maintenance APIs."
          },
          verification: {
            status: "pending",
            summary: "Verify the promoted contract still preserves the existing chat, hands, and Telegram behavior when idle."
          }
        };
    }
  });
}

function buildReflectionSummary(
  session: SessionRecord,
  metrics: {
    assistantMessageCount: number;
    proofSignalCount: number;
    reasoningSignalCount: number;
    toolEventCount: number;
    unresolvedPromptCount: number;
  }
): string {
  const latestUser = [...session.messages].reverse().find((message) => message.role === "user")?.content;
  const latestAssistant = [...session.messages]
    .reverse()
    .find((message) => message.role === "assistant")?.content;
  const coverage =
    metrics.proofSignalCount > 0 || metrics.toolEventCount > 0
      ? "evidence-backed reasoning signals were captured"
      : "the session relied on lightweight compatibility reasoning only";

  return [
    `Reflection for ${session.id}: ${session.messages.length} messages and ${metrics.toolEventCount} tool events reviewed; ${coverage}.`,
    `Reasoning/proof signals=${metrics.reasoningSignalCount}/${metrics.proofSignalCount}; unresolved prompts=${metrics.unresolvedPromptCount}.`,
    latestUser ? `Latest user intent: ${trimText(latestUser, 120)}.` : null,
    latestAssistant ? `Latest assistant response: ${trimText(latestAssistant, 120)}.` : null
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function buildMaintenanceSessionId(cron: string, timestamp: string): string {
  const date = timestamp.slice(0, 10);
  return cron === MORNING_BRIEFING_CRON
    ? `${MAINTENANCE_PREFIX}briefing:${date}`
    : `${MAINTENANCE_PREFIX}${date}`;
}

function buildMaintenanceSummary(cron: string, reflections: SessionReflectionResult[]): string {
  const reflected = reflections.filter((reflection) => reflection.persisted);
  const label = cron === MORNING_BRIEFING_CRON ? "Morning briefing" : "Scheduled maintenance";
  const latest = reflected[0]?.sessionId ?? reflections[0]?.sessionId ?? "none";

  return `${label}: reviewed ${reflections.length} recent sessions, persisted ${reflected.length} fresh reflections, latest focus session ${latest}.`;
}

function isSyntheticSessionId(sessionId: string): boolean {
  return (
    sessionId.startsWith(REFLECTION_PREFIX) ||
    sessionId.startsWith(MAINTENANCE_PREFIX) ||
    sessionId.startsWith(HAND_PREFIX) ||
    sessionId.startsWith(IMPROVEMENT_PREFIX)
  );
}

async function readStoredReflectionArtifact(
  database: D1Database,
  reflectionSessionId: string
): Promise<StoredReflectionArtifact | null> {
  const session = await new AaronDbEdgeSessionRepository(database, reflectionSessionId).getSession();
  const latestReflection =
    session?.toolEvents
      .slice()
      .reverse()
      .find((event) => event.toolName === "session-reflection") ?? null;

  if (!latestReflection) {
    return null;
  }

  const metadata = asJsonObject(latestReflection.metadata);
  const improvementSignals = toImprovementSignalRecords(metadata?.improvementSignals);
  if (improvementSignals.length === 0) {
    return null;
  }

  return {
    reflectionSessionId,
    sourceSessionId:
      typeof metadata?.reflectionFor === "string"
        ? metadata.reflectionFor
        : reflectionSessionId.slice(REFLECTION_PREFIX.length),
    sourceLastTx: typeof metadata?.sourceLastTx === "number" ? metadata.sourceLastTx : 0,
    improvementSignals
  };
}

function buildImprovementProposals(artifact: StoredReflectionArtifact): ImprovementProposalRecord[] {
  return buildImprovementCandidates(artifact.improvementSignals).map((candidate) => ({
    ...candidate,
    proposalKey: `${artifact.reflectionSessionId}@${artifact.sourceLastTx}:${candidate.candidateKey}`,
    sourceReflectionSessionId: artifact.reflectionSessionId,
    sourceSessionId: artifact.sourceSessionId,
    sourceLastTx: artifact.sourceLastTx
  }));
}

function toImprovementSignalRecords(value: unknown): ImprovementSignalRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => asJsonObject(entry))
    .filter(
      (entry): entry is ImprovementSignalRecord =>
        entry !== null && typeof entry.signalKey === "string" && typeof entry.summary === "string"
    );
}

function getStoredProposalKeys(toolEvents: ToolEvent[]): Set<string> {
  const proposalKeys = new Set<string>();

  for (const event of toolEvents) {
    const proposals = event.metadata?.proposals;
    if (!Array.isArray(proposals)) {
      continue;
    }

    for (const proposal of proposals) {
      const record = asJsonObject(proposal);
      if (record && typeof record.proposalKey === "string") {
        proposalKeys.add(record.proposalKey);
      }
    }
  }

  return proposalKeys;
}

function previewEvent(event: SessionRecord["events"][number]): string {
  return event.kind === "message" ? event.content : `${event.toolName} ${event.summary}`;
}

function buildMetricEvidence(summary: string): ImprovementEvidenceRecord {
  return {
    kind: "metric",
    summary,
    eventId: null,
    tx: null,
    excerpt: null
  };
}

function buildMessageEvidence(message: MessageEvent, summary: string): ImprovementEvidenceRecord {
  return {
    kind: "message",
    summary,
    eventId: message.id,
    tx: message.tx,
    excerpt: trimText(message.content, 140)
  };
}

function buildToolEventEvidence(event: ToolEvent, summary: string): ImprovementEvidenceRecord {
  return {
    kind: "tool-event",
    summary,
    eventId: event.id,
    tx: event.tx,
    excerpt: trimText(`${event.toolName}: ${event.summary}`, 140)
  };
}

function buildAuditEvidence(audit: JsonObject): ImprovementEvidenceRecord {
  const toolId = typeof audit.toolId === "string" ? audit.toolId : "unknown-tool";
  const outcome = typeof audit.outcome === "string" ? audit.outcome : "unknown-outcome";
  const detail = typeof audit.detail === "string" ? audit.detail : null;

  return {
    kind: "audit",
    summary: `Persisted tool audit recorded ${toolId} with outcome=${outcome}.`,
    eventId: null,
    tx: null,
    excerpt: detail ? trimText(detail, 140) : null
  };
}

function extractToolAuditTrail(metadata: JsonObject | null): JsonObject[] {
  const trail = metadata?.toolAuditTrail;

  if (!Array.isArray(trail)) {
    return [];
  }

  return trail
    .map((entry) => asJsonObject(entry))
    .filter((entry): entry is JsonObject => entry !== null);
}

function asJsonObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length > 1);
}

function trimText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

export const scheduledMaintenanceCrons = {
  maintenance: MAINTENANCE_CRON,
  morningBriefing: MORNING_BRIEFING_CRON
} as const;