import {
  AaronDbEdgeSessionRepository,
  type JsonObject,
  type MessageEvent,
  type SessionRecord,
  type ToolEvent
} from "./session-state";
import { readProviderKeyStatus, readProviderKeyFromEnv } from "./provider-key-store";
import {
  readPersistedModelSelection,
  setPersistedModelSelection
} from "./model-selection-store";
import { createPullRequest, pushFilesToGithub, getLatestWorkflowRun } from "./github-coordinator";
import { KnowledgeHub } from "./knowledge-hub";
import type { SophiaHandProposal } from "./sophia-engine";
import { buildToolAuditRecord } from "./tool-policy";
import { queryKnowledgeVault } from "./knowledge-vault";

const ALL_FACTS_SQL = `
  SELECT session_id, entity, attribute, value_json, tx, tx_index, occurred_at, operation
  FROM aarondb_facts
  WHERE session_id != ?
  ORDER BY session_id ASC, tx ASC, tx_index ASC
`;

const ALL_FACTS_AS_OF_SQL = `
  SELECT session_id, entity, attribute, value_json, tx, tx_index, occurred_at, operation
  FROM aarondb_facts
  WHERE session_id != ? AND occurred_at_dt <= ?
  ORDER BY session_id ASC, tx ASC, tx_index ASC
`;

const REFLECTION_PREFIX = "reflection:";
const MAINTENANCE_PREFIX = "maintenance:";
const HAND_PREFIX = "hand:";
const IMPROVEMENT_PREFIX = "improvement:";
export const IMPROVEMENT_PROPOSAL_SESSION_ID = `${IMPROVEMENT_PREFIX}proposals`;
const MAINTENANCE_CRON = "*/30 * * * *";
const MORNING_BRIEFING_CRON = "0 8 * * *";
const MAX_MAINTENANCE_SESSIONS = 5;
const MAX_USER_CORRECTION_SESSIONS = 12;
const MIN_REPEATED_USER_CORRECTIONS = 2;
const MAX_USER_CORRECTION_EVIDENCE = 3;
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

export type ImprovementRiskLevel = "low" | "medium" | "high";
export type ImprovementVerificationStatus = "pending" | "verified" | "not-needed";
export type ImprovementCandidateStatus =
  | "proposed"
  | "shadowing"
  | "awaiting-approval"
  | "approved"
  | "promoted"
  | "rejected"
  | "paused"
  | "rolled-back";
type ImprovementShadowStatus = "pending" | "completed";
type ImprovementShadowVerdict = "pending" | "awaiting-approval";
type ImprovementApprovalStatus = "pending" | "approved" | "rejected";
export type ImprovementPromotionStatus = "not-promoted" | "promoted" | "rolled-back";

export interface DomainDeclarationRecord extends JsonObject {
  domain: string;
  version: number;
  declaration: any; // DomainDeclaration from aether-engine
  synthesizedAt: string;
  tx: number;
}

export type ImprovementLifecycleAction =
  | "propose"
  | "start-shadow"
  | "complete-shadow"
  | "pause"
  | "approve"
  | "promote"
  | "reject"
  | "nexus-vote"
  | "rollback";

export interface ImprovementEvidenceRecord extends JsonObject {
  kind: "audit" | "message" | "tool-event" | "metric";
  summary: string;
  eventId: string | null;
  tx: number | null;
  excerpt: string | null;
}

export interface ImprovementRiskRecord extends JsonObject {
  level: ImprovementRiskLevel;
  summary: string;
}

export interface ImprovementVerificationRecord extends JsonObject {
  status: ImprovementVerificationStatus;
  summary: string;
}

interface ImprovementShadowEvaluationRecord extends JsonObject {
  mode: "bounded-metadata-shadow";
  status: ImprovementShadowStatus;
  verdict: ImprovementShadowVerdict;
  baselineSummary: string;
  candidateSummary: string;
  comparisonSummary: string;
  baselineEvidenceCount: number;
  baselineRiskLevel: ImprovementRiskLevel;
  baselineVerificationStatus: ImprovementVerificationStatus;
  candidateRiskLevel: ImprovementRiskLevel;
  startedAt: string | null;
  completedAt: string | null;
}

interface ImprovementApprovalRecord extends JsonObject {
  requiresProtectedApproval: true;
  status: ImprovementApprovalStatus;
  approvedAt: string | null;
  rejectedAt: string | null;
  summary: string;
}

export interface NexusVoteRecord extends JsonObject {
  voterNodeId: string;
  voterLabel: string;
  vote: "approve" | "reject";
  timestamp: string;
  weight: number;
}

interface ImprovementPromotionRecord extends JsonObject {
  status: ImprovementPromotionStatus;
  promotedAt: string | null;
  rolledBackAt: string | null;
  productionMutation: "manual-only";
  liveMutationApplied: false;
  summary: string;
}

interface ImprovementLifecycleEntryRecord extends JsonObject {
  action: ImprovementLifecycleAction;
  fromStatus: ImprovementCandidateStatus | "none";
  toStatus: ImprovementCandidateStatus;
  actor: "hand-runtime" | "operator-route";
  timestamp: string;
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
  status: ImprovementCandidateStatus;
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
  shadowEvaluation: ImprovementShadowEvaluationRecord;
  approval: ImprovementApprovalRecord;
  promotion: ImprovementPromotionRecord;
  votes: NexusVoteRecord[];
  complectionScore: number;
  lifecycleHistory: ImprovementLifecycleEntryRecord[];
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
  successEvidenceCount: number;
}

export interface SuccessEvidenceRecord extends JsonObject {
  kind: "success-orbit";
  sessionId: string;
  timestamp: string;
  summary: string;
  trajectory: {
    intent: string;
    outcome: string;
    steps: number;
  };
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

export interface UserCorrectionMiningResult {
  cron: string;
  proposalSessionId: string;
  reviewedSessionIds: string[];
  correctionSignalCount: number;
  correctionSignals: ImprovementSignalRecord[];
  matchedCorrectionCount: number;
  generatedProposalCount: number;
  skippedDuplicateProposalCount: number;
}

export interface ReflexiveAuditResult {
  cron: string;
  auditSessionId: string;
  proposalSessionId: string;
  reviewedFactCount: number;
  latencyAnomalies: number;
  errorClusters: number;
  generatedProposalCount: number;
}

export interface TelemetricAuditResult {
  cron: string;
  auditSessionId: string;
  managedProjectCount: number;
  receivedPulseCount: number;
  generatedProposalCount: number;
}

export async function resolveFactsAsOf(env: any, timestamp: string, excludeSessionId: string = IMPROVEMENT_PROPOSAL_SESSION_ID): Promise<Map<string, Map<string, any>>> {
  const db = env.AARONDB || env.DB;
  if (!db) throw new Error("AARONDB binding not found");

  const facts = await db.prepare(ALL_FACTS_AS_OF_SQL).bind(excludeSessionId, timestamp).all();
  const state = new Map<string, Map<string, any>>();

  for (const row of facts.results as any[]) {
    if (!state.has(row.entity)) {
      state.set(row.entity, new Map<string, any>());
    }
    const entityState = state.get(row.entity)!;
    
    if (row.operation === 'retract') {
      entityState.delete(row.attribute);
    } else {
      entityState.set(row.attribute, JSON.parse(row.value_json));
    }
  }

  return state;
}

export async function runTelemetricAudit(input: {
  env: Pick<Env, "AARONDB">;
  cron: string;
  timestamp?: string;
}): Promise<TelemetricAuditResult> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const db = input.env.AARONDB;
  const auditSessionId = `${MAINTENANCE_PREFIX}telemetric-audit:${timestamp.slice(0, 10)}`;
  const auditRepository = new AaronDbEdgeSessionRepository(db, auditSessionId);
  await ensureSyntheticSession(auditRepository, timestamp);

  // 1. Fetch managed projects
  const projectsFacts = await db.prepare(`
    SELECT entity, value_json FROM aarondb_facts
    WHERE attribute = 'repoUrl' AND operation = 'assert'
  `).all<{ entity: string; value_json: string }>();

  const managedProjects = projectsFacts.results.map(f => ({
    entity: f.entity,
    repoUrl: JSON.parse(f.value_json) as string
  }));

  if (managedProjects.length === 0) {
    return {
      cron: input.cron,
      auditSessionId,
      managedProjectCount: 0,
      receivedPulseCount: 0,
      generatedProposalCount: 0
    };
  }

  // 2. Fetch recent pulses for these projects (last 1 hour)
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
  const pulseFacts = await db.prepare(`
    SELECT entity, attribute, value_json, metadata_json FROM aarondb_facts
    WHERE attribute = 'metricValue' AND operation = 'assert'
    AND occurred_at >= ?
  `).bind(oneHourAgo).all<{ entity: string; attribute: string; value_json: string; metadata_json: string }>();

  // Regroup pulses by project ID (entity in pulses is project ID)
  const projectPulsesMap = new Map<string, any[]>();
  for (const row of pulseFacts.results) {
    const pulses = projectPulsesMap.get(row.entity) || [];
    const meta = JSON.parse(row.metadata_json || "{}");
    pulses.push({
      metricKind: meta.metricKind || "unknown",
      metricValue: JSON.parse(row.value_json)
    });
    projectPulsesMap.set(row.entity, pulses);
  }

  // 3. Orchestrate Engines
  const { auditManagedProjects } = await import("./economos-engine");
  const { distillPulsePatterns } = await import("./sophia-engine");
  const { proposeExternalOptimizations } = await import("./architectura-engine");

  const auditInputs = managedProjects.map(p => ({
    repoUrl: p.repoUrl,
    pulses: projectPulsesMap.get(p.entity) || []
  }));

  const economosReports = await auditManagedProjects(input.env, auditInputs);
  
  const sophiaInputs = managedProjects.map((p, i) => ({
    repoUrl: p.repoUrl,
    metrics: economosReports[i]
  }));
  const pulsePatterns = await distillPulsePatterns(input.env, sophiaInputs);

  const architecturaInputs = managedProjects.map((p, i) => ({
    repoUrl: p.repoUrl,
    patterns: pulsePatterns.filter(pat => pat.id.includes(p.repoUrl)),
    metrics: economosReports[i]
  }));
  const externalProposals = await proposeExternalOptimizations(input.env, architecturaInputs);

  // 4. Record results and generate signals/proposals
  let receivedPulseCount = pulseFacts.results.length;
  let generatedProposalCount = externalProposals.length;

  if (generatedProposalCount > 0) {
    const proposalRepository = new AaronDbEdgeSessionRepository(db, IMPROVEMENT_PROPOSAL_SESSION_ID);
    await ensureSyntheticSession(proposalRepository, timestamp);
    
    // Convert refactor propositions to improvement proposals
    const improvementProposals: ImprovementProposalRecord[] = externalProposals.map(p => ({
      proposalKey: p.id,
      candidateKey: p.id,
      status: "proposed",
      summary: p.rationale,
      problemStatement: `Detected via telemetric audit of ${p.targetModule}.`,
      proposedAction: `Structural refactor (${p.type}) of managed project.`,
      expectedBenefit: `Simplicity gain: ${p.estimatedSimplicityGain}%`,
      riskLevel: "medium",
      verificationPlan: "Verify telemetric pulse recovery after refactor promotion.",
      derivedFromSignalKeys: ["telemetric-audit"],
      evidence: [buildMetricEvidence(p.rationale)],
      risk: { level: "medium", summary: "Automated refactors on managed projects require isolated verification." },
      verification: { status: "pending", summary: "Awaiting pulse feedback from shadow deployment." },
      shadowEvaluation: {
        mode: "bounded-metadata-shadow",
        status: "pending",
        verdict: "pending",
        baselineSummary: "Current telemetric health baseline.",
        candidateSummary: "Proposed structural improvement.",
        comparisonSummary: "Awaiting shadow metrics.",
        baselineEvidenceCount: 1,
        baselineRiskLevel: "medium",
        baselineVerificationStatus: "pending",
        candidateRiskLevel: "medium",
        startedAt: null,
        completedAt: null
      },
      approval: { requiresProtectedApproval: true, status: "pending", summary: "External optimization requires explicit operator approval.", approvedAt: null, rejectedAt: null },
      promotion: { status: "not-promoted", promotedAt: null, rolledBackAt: null, productionMutation: "manual-only", liveMutationApplied: false, summary: "Manual promotion required." },
      votes: [],
      complectionScore: 0,
      lifecycleHistory: [],
      sourceReflectionSessionId: auditSessionId,
      sourceSessionId: "global:pulse",
      sourceLastTx: 0
    }));

    await proposalRepository.appendToolEvent({
      timestamp,
      toolName: "improvement-proposal-review",
      summary: `Telemetric audit generated ${generatedProposalCount} external optimization proposal(s).`,
      metadata: {
        cron: input.cron,
        generatedProposalCount,
        proposals: improvementProposals,
        audit: buildToolAuditRecord({
          toolId: "telemetric-audit-proposals",
          actor: "hand-runtime",
          scope: "hand",
          outcome: "succeeded",
          timestamp,
          sessionId: IMPROVEMENT_PROPOSAL_SESSION_ID,
          detail: `Telemetric audit generated ${generatedProposalCount} external optimization proposal(s).`
        })
      }
    });
  }

  await auditRepository.appendToolEvent({
    timestamp,
    toolName: "telemetric-audit",
    summary: `Telemetric audit reviewed ${managedProjects.length} managed project(s). Pulses: ${receivedPulseCount}. Proposals: ${generatedProposalCount}.`,
    metadata: {
      cron: input.cron,
      managedProjectCount: managedProjects.length,
      receivedPulseCount,
      generatedProposalCount,
      audit: buildToolAuditRecord({
        toolId: "telemetric-audit",
        actor: "maintenance-runtime",
        scope: "maintenance",
        outcome: "succeeded",
        timestamp,
        sessionId: auditSessionId,
        detail: `Telemetric audit reviewed ${managedProjects.length} projects.`
      })
    }
  });

  return {
    cron: input.cron,
    auditSessionId,
    managedProjectCount: managedProjects.length,
    receivedPulseCount,
    generatedProposalCount
  };
}

type UserCorrectionPatternKey =
  | "evidence-contract"
  | "tool-backed-investigation"
  | "instruction-restatement";

interface UserCorrectionPatternDefinition {
  patternKey: UserCorrectionPatternKey;
  signalKey: string;
  candidateKey: string;
  category: ImprovementSignalRecord["category"];
  signalSummary: string;
  candidateSummary: string;
  proposedAction: string;
  expectedBenefit: string;
  riskLevel: ImprovementRiskLevel;
  riskSummary: string;
  verificationPlan: string;
}

interface UserCorrectionMatch {
  sessionId: string;
  assistantMessage: MessageEvent;
  correctionMessage: MessageEvent;
  pattern: UserCorrectionPatternDefinition;
}

const USER_CORRECTION_PATTERNS: readonly UserCorrectionPatternDefinition[] = [
  {
    patternKey: "evidence-contract",
    signalKey: "repeated-user-correction-evidence-contract",
    candidateKey: "strengthen-evidence-contract-from-corrections",
    category: "verification",
    signalSummary:
      "Recent session history shows repeated user/operator corrections asking for evidence or proof after an assistant answer.",
    candidateSummary:
      "Strengthen the answer contract so evidence/proof requests are satisfied before users need to correct the assistant.",
    proposedAction:
      "Strengthen the answer contract so evidence/proof requests are satisfied before users need to correct the assistant.",
    expectedBenefit:
      "Reduces repeated evidence-seeking corrections while keeping the live runtime bounded and review-driven.",
    riskLevel: "medium",
    riskSummary:
      "Tightening the evidence contract may increase latency or explicit uncertainty, so it should move through review rather than mutate production behavior directly.",
    verificationPlan:
      "Verify later sessions reduce repeated evidence/proof corrections without regressing current chat, hands, or Telegram stability."
  },
  {
    patternKey: "tool-backed-investigation",
    signalKey: "repeated-user-correction-tool-investigation",
    candidateKey: "add-tool-backed-investigation-after-corrections",
    category: "verification",
    signalSummary:
      "Recent session history shows repeated user/operator corrections asking the assistant to inspect logs, traces, or tools before concluding.",
    candidateSummary:
      "Prompt tool-backed investigation before confident conclusions when repeated corrections ask for inspection or trace review.",
    proposedAction:
      "Prompt tool-backed investigation before confident conclusions when repeated corrections ask for inspection or trace review.",
    expectedBenefit:
      "Moves repeated correction pressure into a structured reviewable proposal for better evidence discipline.",
    riskLevel: "medium",
    riskSummary:
      "Extra tool-backed investigation can increase cost or latency, so it should be reviewed before any wider adoption.",
    verificationPlan:
      "Verify later sessions record the expected tool traces and reduce repeated inspection/trace corrections for similar asks."
  },
  {
    patternKey: "instruction-restatement",
    signalKey: "repeated-user-correction-instruction-restatement",
    candidateKey: "reduce-instruction-drift-from-corrections",
    category: "follow-up",
    signalSummary:
      "Recent session history shows repeated user/operator corrections restating constraints after the assistant already answered.",
    candidateSummary:
      "Reduce instruction drift that forces users to restate constraints after the assistant responds.",
    proposedAction:
      "Reduce instruction drift that forces users to restate constraints after the assistant responds.",
    expectedBenefit:
      "Turns repeated constraint-restatement corrections into a bounded improvement candidate instead of hidden live prompt mutation.",
    riskLevel: "low",
    riskSummary:
      "Constraint-handling changes are comparatively low risk, but they still require review to avoid overfitting to a narrow correction pattern.",
    verificationPlan:
      "Verify later sessions reduce repeated constraint-restatement corrections while preserving the current operator-facing behavior."
  }
] as const;

export interface ImprovementShadowEvaluationResult {
  cron: string;
  proposalSessionId: string;
  evaluatedProposalCount: number;
  awaitingApprovalCount: number;
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
      improvementCandidateCount: 0,
      successEvidenceCount: 0
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
      improvementCandidateCount: 0,
      successEvidenceCount: 0
    };
  }

  const metrics = analyzeSession(sourceSession);
  const improvementSignals = buildImprovementSignals(sourceSession, metrics);
  const improvementCandidates = buildImprovementCandidates(improvementSignals, timestamp);
  const successEvidence = buildSuccessEvidence(sourceSession, metrics, timestamp);
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
      successEvidenceCount: successEvidence.length,
      improvementSignals,
      improvementCandidates,
      successEvidence,
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
    improvementCandidateCount: improvementCandidates.length,
    successEvidenceCount: successEvidence.length
  };
}

function buildSuccessEvidence(
  session: SessionRecord,
  metrics: ReturnType<typeof analyzeSession>,
  timestamp: string
): SuccessEvidenceRecord[] {
  // 🧙🏾‍♂️ Success is a signal for structural synthesis.
  // Criteria: Good reasoning signals, tool traces present, and zero degraded audits.
  const evidence: SuccessEvidenceRecord[] = [];
  
  const hasSuccessfulOrbit = 
    metrics.proofSignalCount >= 2 && 
    metrics.toolEventCount >= 1 && 
    metrics.unresolvedPromptCount === 0;

  if (hasSuccessfulOrbit) {
    const latestUser = [...session.messages].reverse().find(m => m.role === "user")?.content || "unknown";
    const latestAssistant = [...session.messages].reverse().find(m => m.role === "assistant")?.content || "No resolution recorded.";

    evidence.push({
      kind: "success-orbit",
      sessionId: session.id,
      timestamp,
      summary: `Successful end-to-end orbit detected: ${trimText(latestUser, 60)} -> RESOLVED.`,
      trajectory: {
        intent: latestUser,
        outcome: latestAssistant,
        steps: session.events.length
      }
    });
  }

  return evidence;
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
    for (const proposal of buildImprovementProposals(artifact, timestamp)) {
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

export async function runScheduledUserCorrectionMining(input: {
  env: Pick<Env, "AARONDB">;
  cron: string;
  timestamp?: string;
}): Promise<UserCorrectionMiningResult> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const reviewedSessionIds = await listRecentSessionIds(input.env.AARONDB, MAX_USER_CORRECTION_SESSIONS);
  const sessions = await Promise.all(
    reviewedSessionIds.map((sessionId) =>
      new AaronDbEdgeSessionRepository(input.env.AARONDB, sessionId).getSession()
    )
  );
  const correctionMatches = sessions.flatMap((session) =>
    session ? extractUserCorrectionMatches(session) : []
  );
  const repeatedGroups = groupRepeatedUserCorrections(correctionMatches);
  const correctionSignals = repeatedGroups.map(({ pattern, matches }) =>
    buildUserCorrectionSignal(pattern, matches)
  );
  const allProposals = correctionSignals.map((signal) => buildUserCorrectionProposal(signal, timestamp));
  const matchedCorrectionCount = repeatedGroups.reduce((total, group) => total + group.matches.length, 0);
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
      summary: `User-correction miner reviewed ${reviewedSessionIds.length} session(s), matched ${matchedCorrectionCount} repeated correction(s), and wrote ${freshProposals.length} structured proposal(s).`,
      metadata: {
        cron: input.cron,
        correctionSignalCount: correctionSignals.length,
        correctionSignals,
        generatedProposalCount: freshProposals.length,
        matchedCorrectionCount,
        proposals: freshProposals,
        reviewedSessionCount: reviewedSessionIds.length,
        reviewedSessionIds,
        reviewedSignalCount: correctionSignals.length,
        skippedDuplicateProposalCount: allProposals.length - freshProposals.length,
        sourceHandId: "user-correction-miner",
        audit: buildToolAuditRecord({
          toolId: "improvement-proposal-review",
          actor: "hand-runtime",
          scope: "hand",
          outcome: "succeeded",
          timestamp,
          handId: "user-correction-miner",
          sessionId: IMPROVEMENT_PROPOSAL_SESSION_ID,
          detail: `User-correction miner wrote ${freshProposals.length} structured proposal(s) from ${matchedCorrectionCount} repeated correction(s).`,
          extra: {
            cron: input.cron,
            correctionSignalCount: correctionSignals.length,
            generatedProposalCount: freshProposals.length,
            matchedCorrectionCount,
            reviewedSessionCount: reviewedSessionIds.length,
            skippedDuplicateProposalCount: allProposals.length - freshProposals.length
          }
        })
      }
    });
  }

  return {
    cron: input.cron,
    proposalSessionId: IMPROVEMENT_PROPOSAL_SESSION_ID,
    reviewedSessionIds,
    correctionSignalCount: correctionSignals.length,
    correctionSignals,
    matchedCorrectionCount,
    generatedProposalCount: freshProposals.length,
    skippedDuplicateProposalCount: allProposals.length - freshProposals.length
  };
}

export async function runAutonomousEvolution(input: {
  env: any;
  cron: string;
  timestamp?: string;
}): Promise<{
  cron: string;
  handSessionId: string;
  generatedHandCount: number;
  promotedCount: number;
  distilledCount: number;
  proposals: SophiaHandProposal[];
}> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const reflectionArtifacts = await listRecentStoredReflectionArtifacts(input.env.AARONDB, MAX_MAINTENANCE_SESSIONS);
  
  const allEvidence = reflectionArtifacts.flatMap(a => a.successEvidence || []);

  const { distillEvidence } = await import("./sophia-engine");
  const proposals = await distillEvidence(input.env, allEvidence);

  const promotedCount = proposals.filter((p) => p.status === "promoted").length;
  const distilledCount = proposals.length - promotedCount;

  const handSessionId = `${HAND_PREFIX}synthesized`;
  const handRepository = new AaronDbEdgeSessionRepository(input.env.AARONDB, handSessionId);

  if (proposals.length > 0) {
    await ensureSyntheticSession(handRepository, timestamp);
    await handRepository.appendToolEvent({
      timestamp,
      toolName: "structural-hand-synthesis",
      summary: `Sophia Distiller generated ${proposals.length} structural hand proposal(s) from success evidence. Promoted: ${promotedCount}, Distilled: ${distilledCount}.`,
      metadata: {
        cron: input.cron,
        proposals,
        audit: buildToolAuditRecord({
          toolId: "structural-hand-synthesis",
          actor: "hand-runtime",
          scope: "hand",
          outcome: "succeeded",
          timestamp,
          handId: "sophia-distiller",
          sessionId: handSessionId,
          detail: `Sophia Distiller generated ${proposals.length} structural hand proposal(s). (${promotedCount} promoted)`,
          extra: { proposals: proposals.length, promotedCount, distilledCount }
        })
      }
    });

    if (promotedCount > 0) {
      // 🧙🏾‍♂️ Write the promoted proposals into the improvement candidate store 
      // so the factory's standard review mechanisms (or automated Nexus voting) can pick them up.
      const proposalRepository = new AaronDbEdgeSessionRepository(
        input.env.AARONDB,
        IMPROVEMENT_PROPOSAL_SESSION_ID
      );
      await ensureSyntheticSession(proposalRepository, timestamp);
      await proposalRepository.appendToolEvent({
        timestamp,
        toolName: "improvement-proposal-review",
        summary: `Sophia automatically promoted ${promotedCount} new hand candidate(s) to the improvement pipeline.`,
        metadata: {
          cron: input.cron,
          generatedProposalCount: promotedCount,
          proposals: proposals.filter(p => p.status === "promoted").map(p => ({
            candidateKey: p.handId,
            status: "proposed",
            summary: p.description,
            problemStatement: "Synthesized automatically from successful orbit trajectory.",
            proposedAction: `Implement new structural hand: ${p.name}`,
            expectedBenefit: p.intentPattern,
            riskLevel: "low",
            verificationPlan: "Verify new Hand correctly intercepts mapped intent.",
            derivedFromSignalKeys: ["sophia-distillation"],
            evidence: [],
            risk: { level: "low", summary: "Synthesized from observed verified success." },
            verification: { status: "pending", summary: "Awaiting shadow or live traffic verification." },
            shadowEvaluation: {
              mode: "bounded-metadata-shadow",
              status: "pending",
              verdict: "pending",
              baselineSummary: "",
              candidateSummary: "",
              comparisonSummary: "",
              baselineEvidenceCount: 0,
              baselineRiskLevel: "low",
              baselineVerificationStatus: "pending",
              candidateRiskLevel: "low",
              startedAt: timestamp,
              completedAt: null
            },
            approval: {
              requiresProtectedApproval: true,
              status: "pending",
              approvedAt: null,
              rejectedAt: null,
              summary: "Awaiting structural review."
            },
            promotion: {
              status: "not-promoted",
              promotedAt: null,
              rolledBackAt: null,
              productionMutation: "manual-only",
              liveMutationApplied: false,
              summary: "Awaiting final promotion to substrate."
            },
            votes: [],
            complectionScore: 0,
            lifecycleHistory: [
              {
                action: "propose",
                fromStatus: "none",
                toStatus: "proposed",
                actor: "hand-runtime",
                timestamp,
                summary: "Synthesized explicitly by Sophia."
              }
            ],
            proposalKey: `sophia:${timestamp}:${p.handId}`,
            sourceReflectionSessionId: "synthetic-sophia",
            sourceSessionId: "synthetic-sophia",
            sourceLastTx: 0
          })),
          reviewedReflectionCount: reflectionArtifacts.length,
          reviewedSignalCount: allEvidence.length,
          skippedDuplicateProposalCount: 0
        }
      });
    }
  }

  return {
    cron: input.cron,
    handSessionId,
    generatedHandCount: proposals.length,
    promotedCount,
    distilledCount,
    proposals
  };
}

export async function runScheduledImprovementShadowEvaluation(input: {
  env: Pick<Env, "AARONDB" | "DB">;
  cron: string;
  timestamp?: string;
}): Promise<ImprovementShadowEvaluationResult> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const proposalRepository = new AaronDbEdgeSessionRepository(
    input.env.AARONDB,
    IMPROVEMENT_PROPOSAL_SESSION_ID
  );
  const proposalState = await readImprovementProposalState({ env: input.env });
  const proposalsToEvaluate = proposalState.proposals.filter((proposal) => proposal.status === "proposed");

  if (proposalsToEvaluate.length > 0) {
    await ensureSyntheticSession(proposalRepository, timestamp);
    const evaluatedProposals = proposalsToEvaluate.map((proposal) =>
      completeShadowEvaluation(markShadowEvaluationStarted(proposal, timestamp), timestamp)
    );

    await proposalRepository.appendToolEvent({
      timestamp,
      toolName: "improvement-shadow-evaluation",
      summary: `Improvement Hand completed bounded shadow evaluation for ${evaluatedProposals.length} proposal(s); ${evaluatedProposals.length} now await protected approval.`,
      metadata: {
        cron: input.cron,
        evaluatedProposalCount: evaluatedProposals.length,
        awaitingApprovalCount: evaluatedProposals.length,
        evaluationMode: "bounded-metadata-shadow",
        proposals: evaluatedProposals,
        audit: buildToolAuditRecord({
          toolId: "improvement-shadow-evaluation",
          actor: "hand-runtime",
          scope: "hand",
          outcome: "succeeded",
          timestamp,
          handId: "improvement-hand",
          sessionId: IMPROVEMENT_PROPOSAL_SESSION_ID,
          detail: `Improvement Hand completed bounded shadow evaluation for ${evaluatedProposals.length} proposal(s).`,
          extra: {
            cron: input.cron,
            evaluatedProposalCount: evaluatedProposals.length,
            awaitingApprovalCount: evaluatedProposals.length,
            evaluationMode: "bounded-metadata-shadow"
          }
        })
      }
    });
  }

  return {
    cron: input.cron,
    proposalSessionId: IMPROVEMENT_PROPOSAL_SESSION_ID,
    evaluatedProposalCount: proposalsToEvaluate.length,
    awaitingApprovalCount: proposalsToEvaluate.length
  };
}

export async function readImprovementProposalState(input: {
  env: Pick<Env, "AARONDB">;
}): Promise<{
  proposalSessionId: string;
  proposals: ImprovementProposalRecord[];
}> {
  const proposalSession = await new AaronDbEdgeSessionRepository(
    input.env.AARONDB,
    IMPROVEMENT_PROPOSAL_SESSION_ID
  ).getSession();
  const proposalMap = new Map<string, ImprovementProposalRecord>();

  for (const event of proposalSession?.toolEvents ?? []) {
    for (const proposal of toImprovementProposalRecords(event.metadata?.proposals)) {
      proposalMap.set(proposal.proposalKey, proposal);
    }
  }

  return {
    proposalSessionId: IMPROVEMENT_PROPOSAL_SESSION_ID,
    proposals: [...proposalMap.values()].sort((left, right) => left.proposalKey.localeCompare(right.proposalKey))
  };
}

export async function recordImprovementLifecycleAction(input: {
  env: Pick<Env, "AARONDB" | "DB" | "GITHUB_TOKEN" | "CLOUDFLARE_ACCOUNT_ID">;
  proposalKey: string;
  action: ImprovementLifecycleAction;
  timestamp?: string;
  extra?: JsonObject;
}): Promise<ImprovementProposalRecord> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const proposalRepository = new AaronDbEdgeSessionRepository(
    input.env.AARONDB,
    IMPROVEMENT_PROPOSAL_SESSION_ID
  );
  const proposalState = await readImprovementProposalState({ env: input.env });
  const currentProposal = proposalState.proposals.find((proposal) => proposal.proposalKey === input.proposalKey);

  if (!currentProposal) {
    throw new Error(`Improvement proposal ${input.proposalKey} was not found.`);
  }

  const updatedProposal = applyLifecycleAction(currentProposal, input.action, timestamp, input.extra);
  
  // 🧙🏾‍♂️ Rich Hickey: Side effects should be explicit and bounded.
  // When an improvement is approved, we draft a PR if GitHub is configured.
  if (input.action === "approve") {
    try {
      const githubKey = await readProviderKeyStatus({
        env: input.env as any,
        database: input.env.AARONDB,
        provider: "github"
      });

      if (githubKey.configured && githubKey.validation.status === "valid") {
        // Note: For now we assume the repo is the same as the project root.
        // In a multi-repo factory, this would be derived from the proposal metadata.
        const token = readProviderKeyFromEnv(input.env as any, "github") || "";
        
        // This is a placeholder for the actual file change synthesis.
        // In Phase 3, we'd use the LLM to generate the implementation files.
        // For the loop proof, we just create a tracking PR.
        await createPullRequest(token, "criticalinsight", "aaronclaw", {
          title: `[Improvement] ${updatedProposal.summary}`,
          body: `## Problem Statement\n${updatedProposal.problemStatement}\n\n## Proposed Action\n${updatedProposal.proposedAction}\n\n## Expected Benefit\n${updatedProposal.expectedBenefit}\n\nGenerated by AaronClaw Software Factory Reflection Engine.`,
          head: `improvement/${updatedProposal.proposalKey.slice(0, 8)}`,
          base: "main"
        });
      }
    } catch (error) {
       console.error("Failed to draft improvement PR", error);
       // We don't block the lifecycle update on PR failure, just log it.
    }
  }

  // Phase 4: Knowledge Hub - Contribute promoted patterns to global knowledge
  if (input.action === "promote") {
    try {
      const dbs: D1Database[] = [input.env.AARONDB];
      if (input.env.DB) dbs.push(input.env.DB);
      const hub = new KnowledgeHub(dbs);
      await hub.contributePattern({
        patternKey: updatedProposal.candidateKey as string,
        category: updatedProposal.category as string,
        problemStatement: updatedProposal.problemStatement as string,
        proposedAction: updatedProposal.proposedAction as string,
        expectedBenefit: updatedProposal.expectedBenefit as string
      });
    } catch (error) {
      console.error("Failed to contribute pattern to Knowledge Hub", error);
    }
  }

  if (input.action === "nexus-vote") {
    const voteData = input.extra?.vote as NexusVoteRecord;
    if (voteData) {
      const votes = updatedProposal.votes || [];
      const existingVoteIndex = votes.findIndex(v => v.voterNodeId === voteData.voterNodeId);
      if (existingVoteIndex >= 0) {
        votes[existingVoteIndex] = voteData;
      } else {
        votes.push(voteData);
      }
      updatedProposal.votes = votes;

      // Auto-promotion logic: if > 50% weight approves, auto-promote if pending approval
      const totalWeight = votes.reduce((acc, v) => acc + v.weight, 0);
      const approveWeight = votes.filter(v => v.vote === "approve").reduce((acc, v) => acc + v.weight, 0);

      if (approveWeight > totalWeight / 2 && updatedProposal.status === "awaiting-approval") {
        updatedProposal.status = "approved";
        updatedProposal.approval.status = "approved";
        updatedProposal.approval.approvedAt = timestamp;
        updatedProposal.approval.summary = `Nexus consensus reached: ${approveWeight}/${totalWeight} weight approved.`;
      }
    }
  }

  await ensureSyntheticSession(proposalRepository, timestamp);
  const summary: string = (updatedProposal.lifecycleHistory[updatedProposal.lifecycleHistory.length - 1]?.summary as string) ??
    `Improvement lifecycle ${input.action} recorded for ${currentProposal.proposalKey}.`;

  await proposalRepository.appendToolEvent({
    timestamp,
    toolName: "improvement-candidate-review",
    summary,
    metadata: {
      action: input.action,
      proposalKey: input.proposalKey,
      proposals: [updatedProposal],
      audit: buildToolAuditRecord({
        toolId: "improvement-candidate-review",
        actor: "operator-route",
        scope: "operator",
        outcome: "succeeded",
        timestamp,
        sessionId: IMPROVEMENT_PROPOSAL_SESSION_ID,
        detail: summary,
        extra: {
          action: input.action,
          proposalKey: input.proposalKey,
          status: updatedProposal.status
        }
      })
    }
  });

  return updatedProposal;
}

export async function runReflexiveAudit(input: {
  env: Pick<Env, "AARONDB" | "DB">;
  cron: string;
  timestamp?: string;
}): Promise<ReflexiveAuditResult> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const auditSessionId = `${MAINTENANCE_PREFIX}reflexive-audit:${timestamp.slice(0, 10)}`;
  const auditRepository = new AaronDbEdgeSessionRepository(input.env.AARONDB, auditSessionId);
  await ensureSyntheticSession(auditRepository, timestamp);

  // 🧙🏾‍♂️ Rich Hickey: Observation is the first step to de-complecting state.
  // We query for recent tool performance and failure modes.
  const auditFacts = await input.env.AARONDB.prepare(`
    SELECT value_json, occurred_at FROM aarondb_facts
    WHERE entity = 'tool_audit' OR entity = 'tool_event'
    ORDER BY occurred_at DESC LIMIT 500
  `).all<{ value_json: string; occurred_at: string }>();

  const toolStats = new Map<string, { latencies: number[]; errors: number; total: number }>();
  for (const row of auditFacts.results ?? []) {
    try {
      const data = JSON.parse(row.value_json) as any;
      const toolId = data.toolId || data.toolName;
      if (!toolId) continue;

      const stats = toolStats.get(toolId) ?? { latencies: [], errors: 0, total: 0 };
      stats.total += 1;
      if (data.durationMs) stats.latencies.push(data.durationMs);
      if (data.outcome === "failed" || data.status === "failed") stats.errors += 1;
      toolStats.set(toolId, stats);
    } catch {}
  }

  const signals: ImprovementSignalRecord[] = [];
  let latencyAnomalies = 0;
  let errorClusters = 0;

  for (const [toolId, stats] of toolStats.entries()) {
    // 1. Latency Anomaly Detection
    if (stats.latencies.length >= 3) {
      const avg = stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length;
      const recent = stats.latencies[0];
      if (recent > avg * 2 && recent > 500) {
        latencyAnomalies += 1;
        signals.push({
          signalKey: `latency-anomaly-${toolId}`,
          category: "verification",
          status: "active",
          summary: `Tool ${toolId} showed a latency spike (recent=${recent}ms vs avg=${Math.round(avg)}ms).`,
          evidence: [buildMetricEvidence(`toolId=${toolId}; recent=${recent}ms; avg=${Math.round(avg)}ms`)],
          risk: { level: "medium", summary: "Degrading tool performance affects overall UX and costs." },
          verification: { status: "pending", summary: "Monitor later runs for stabilization or further degradation." }
        });
      }
    }

    // 2. Error Clustering
    if (stats.errors >= 2 && stats.errors / stats.total > 0.2) {
      errorClusters += 1;
      signals.push({
        signalKey: `error-cluster-${toolId}`,
        category: "verification",
        status: "active",
        summary: `Tool ${toolId} has a high failure rate (${Math.round((stats.errors / stats.total) * 100)}%).`,
        evidence: [buildMetricEvidence(`toolId=${toolId}; errors=${stats.errors}; total=${stats.total}`)],
        risk: { level: "high", summary: "Frequent tool failures may indicate upstream outages or corrupted state." },
        verification: { status: "pending", summary: "Verify if failure is transient or systemic." }
      });
    }
  }

  // Phase 4: Knowledge Hub - Augment audit with shared patterns
  const dbs: D1Database[] = [input.env.AARONDB];
  if (input.env.DB) dbs.push(input.env.DB);
  const hub = new KnowledgeHub(dbs);
  const sharedPatterns = await hub.queryKnowledge();

  const allProposals = signals.map((signal) => {
    // Check if the Hub has a relevant pattern for this signal
    const matchingPattern = sharedPatterns.find(p =>
      p.category === signal.category &&
      (p.problemStatement.toLowerCase().includes(signal.summary.toLowerCase()) ||
       signal.summary.toLowerCase().includes(p.problemStatement.toLowerCase()))
    );

    const seed = matchingPattern ? {
      candidateKey: matchingPattern.patternKey,
      summary: `Cross-pollinated correction: ${matchingPattern.expectedBenefit}`,
      problemStatement: signal.summary,
      proposedAction: matchingPattern.proposedAction,
      expectedBenefit: matchingPattern.expectedBenefit,
      riskLevel: "low" as const, // Pattern is proven
      verificationPlan: "Verify via Knowledge Hub success metrics.",
      derivedFromSignalKeys: [signal.signalKey],
      evidence: [...signal.evidence, buildMetricEvidence(`knowledge-hub-match=${matchingPattern.patternKey}`)],
      risk: signal.risk,
      verification: signal.verification
    } : {
      candidateKey: signal.signalKey.replace(/[^a-zA-Z0-9]/g, "-"),
      summary: `Reflexive correction for ${signal.signalKey}`,
      problemStatement: signal.summary,
      proposedAction: "Investigate and stabilize the affected subsystem.",
      expectedBenefit: "Restores system reliability and performance baseline.",
      riskLevel: "medium" as const,
      verificationPlan: "Verify metrics stabilize in future reflexive audit rounds.",
      derivedFromSignalKeys: [signal.signalKey],
      evidence: signal.evidence,
      risk: signal.risk,
      verification: signal.verification
    };

    return buildImprovementCandidateRecord(seed, timestamp);
  });

  const proposalRepository = new AaronDbEdgeSessionRepository(input.env.AARONDB, IMPROVEMENT_PROPOSAL_SESSION_ID);
  const existingProposalKeys = getStoredProposalKeys((await proposalRepository.getSession())?.toolEvents ?? []);
  const freshProposals = (allProposals as ImprovementCandidateRecord[]).filter((p) => !existingProposalKeys.has(`audit:${p.candidateKey}`));
  
  // Tag them with audit prefix for proposal keys
  const taggedProposals = freshProposals.map(p => ({
     ...p,
     proposalKey: `audit:${p.candidateKey}`,
     sourceReflectionSessionId: auditSessionId,
     sourceSessionId: "reflexive-audit",
     sourceLastTx: 0
  })) as ImprovementProposalRecord[];

  // Phase 5: Auto-Pilot Promotion Logic
  // 🧙🏾‍♂️ High-confidence or safe patterns bypass the review queue for the next spawn generation.
  const processedProposals = taggedProposals.map(p => {
     if (p.category === "follow-up" && (p.candidateKey.includes("drift") || p.candidateKey.includes("docs"))) {
        return { ...p, status: "promoted" as const };
     }
     return p;
  });

  // 🧙🏾‍♂️ Simplicity & Provenance.
  // Phase 4: Governance Bouncer - Filter proposals based on policy.
  const bouncer = new GovernanceBouncer(input.env.AARONDB);
  const approvedProposals = await bouncer.filterProposals(processedProposals);

  if (approvedProposals.length > 0) {
    await ensureSyntheticSession(proposalRepository, timestamp);
    await proposalRepository.appendToolEvent({
      timestamp,
      toolName: "improvement-proposal-review",
      summary: `Reflexive Audit identified ${latencyAnomalies} latency anomaly(ies) and ${errorClusters} error cluster(s), writing ${approvedProposals.length} proposal(s).`,
      metadata: {
        cron: input.cron,
        generatedProposalCount: approvedProposals.length,
        proposals: approvedProposals,
        auditSessionId,
        latencyAnomalies,
        errorClusters,
        audit: buildToolAuditRecord({
          toolId: "reflexive-audit",
          actor: "hand-runtime",
          scope: "hand",
          outcome: "succeeded",
          timestamp,
          handId: "improvement-hand",
          sessionId: IMPROVEMENT_PROPOSAL_SESSION_ID,
          detail: "Reflexive audit completed.",
          extra: { latencyAnomalies, errorClusters }
        })
      }
    });
  }

  return {
    cron: input.cron,
    auditSessionId,
    proposalSessionId: IMPROVEMENT_PROPOSAL_SESSION_ID,
    reviewedFactCount: auditFacts.results?.length ?? 0,
    latencyAnomalies,
    errorClusters,
    generatedProposalCount: taggedProposals.length
  };
}

export interface StoredReflectionArtifact {
  reflectionSessionId: string;
  sourceSessionId: string;
  sourceLastTx: number;
  improvementSignals: ImprovementSignalRecord[];
  successEvidence: SuccessEvidenceRecord[];
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

export async function listRecentStoredReflectionArtifacts(
  database: D1Database,
  limit = MAX_MAINTENANCE_SESSIONS
): Promise<StoredReflectionArtifact[]> {
  const reflectionSessionIds = await listRecentReflectionSessionIds(database, limit);

  return (
    await Promise.all(
      reflectionSessionIds.map((reflectionSessionId) => readStoredReflectionArtifact(database, reflectionSessionId))
    )
  ).filter((artifact): artifact is StoredReflectionArtifact => artifact !== null);
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
  signals: ImprovementSignalRecord[],
  timestamp: string
): ImprovementCandidateRecord[] {
  return signals.map((signal) => {
    switch (signal.signalKey) {
      case "evidence-intent-without-tool-trace":
        return buildImprovementCandidateRecord(
          {
            candidateKey: "add-tool-backed-verification-step",
            summary:
              "Add a tool-backed verification checkpoint before final answers when the turn asks for proof or evidence.",
            problemStatement: signal.summary,
            proposedAction:
              "Add a tool-backed verification checkpoint before final answers when the turn asks for proof or evidence.",
            expectedBenefit:
              "Makes proof-oriented answers more trustworthy by persisting an explicit evidence trail.",
            riskLevel: "medium",
            verificationPlan:
              "Verify future runs persist a tool trace and reduce recurrence of this signal for similar prompts.",
            derivedFromSignalKeys: [signal.signalKey],
            evidence: signal.evidence,
            risk: {
              level: "medium",
              summary:
                "Adding a verification checkpoint increases latency slightly, but it lowers the chance of unsupported reasoning."
            },
            verification: {
              status: "pending",
              summary:
                "Verify future runs persist a tool trace and reduce recurrence of this signal for similar prompts."
            }
          },
          timestamp
        );
      case "open-user-questions":
        return buildImprovementCandidateRecord(
          {
            candidateKey: "add-explicit-follow-up-closure",
            summary:
              "Add an explicit closure or deferred-follow-up marker when a user question remains unresolved in session history.",
            problemStatement: signal.summary,
            proposedAction:
              "Add an explicit closure or deferred-follow-up marker when a user question remains unresolved in session history.",
            expectedBenefit:
              "Prevents unresolved questions from silently accumulating and degrading operator trust.",
            riskLevel: "low",
            verificationPlan:
              "Verify later automation can distinguish resolved, deferred, and still-open questions from persisted metadata.",
            derivedFromSignalKeys: [signal.signalKey],
            evidence: signal.evidence,
            risk: {
              level: "low",
              summary:
                "Closure metadata is low risk, but it needs a consistent status vocabulary before broader automation reads it."
            },
            verification: {
              status: "pending",
              summary:
                "Verify later automation can distinguish resolved, deferred, and still-open questions from persisted metadata."
            }
          },
          timestamp
        );
      case "degraded-tool-audit":
        return buildImprovementCandidateRecord(
          {
            candidateKey: "stabilize-degraded-tool-path",
            summary: "Stabilize or clearly gate the degraded tool path surfaced by persisted audit failures.",
            problemStatement: signal.summary,
            proposedAction:
              "Stabilize or clearly gate the degraded tool path surfaced by persisted audit failures.",
            expectedBenefit:
              "Makes degraded tool behavior explicit and lowers the chance of hidden runtime erosion.",
            riskLevel: "medium",
            verificationPlan:
              "Verify later runs either remove the degraded audit or intentionally preserve it with an explicit blocked policy reason.",
            derivedFromSignalKeys: [signal.signalKey],
            evidence: signal.evidence,
            risk: {
              level: "medium",
              summary:
                "Repairing a degraded tool path may touch capability gates, so verification should stay narrow and operator-visible."
            },
            verification: {
              status: "pending",
              summary:
                "Verify later runs either remove the degraded audit or intentionally preserve it with an explicit blocked policy reason."
            }
          },
          timestamp
        );
      case "assistant-fallback-observed":
        return buildImprovementCandidateRecord(
          {
            candidateKey: "track-and-reduce-fallback-frequency",
            summary:
              "Track fallback frequency and reduce avoidable fallback use on the preferred assistant route.",
            problemStatement: signal.summary,
            proposedAction:
              "Track fallback frequency and reduce avoidable fallback use on the preferred assistant route.",
            expectedBenefit:
              "Improves confidence in the preferred assistant path while preserving deterministic fallback continuity.",
            riskLevel: "medium",
            verificationPlan:
              "Verify the preferred route succeeds on later runs without regressing deterministic fallback continuity.",
            derivedFromSignalKeys: [signal.signalKey],
            evidence: signal.evidence,
            risk: {
              level: "medium",
              summary:
                "Route recovery work can destabilize the happy path unless it stays additive and preserves deterministic fallback behavior."
            },
            verification: {
              status: "pending",
              summary:
                "Verify the preferred route succeeds on later runs without regressing deterministic fallback continuity."
            }
          },
          timestamp
        );
      default:
        return buildImprovementCandidateRecord(
          {
            candidateKey: "promote-evidence-backed-pattern",
            summary:
              "Promote the current evidence-backed reasoning pattern into a reusable skill/maintenance prompt contract.",
            problemStatement: signal.summary,
            proposedAction:
              "Promote the current evidence-backed reasoning pattern into a reusable skill/maintenance prompt contract.",
            expectedBenefit:
              "Captures a successful evidence-backed behavior in a reusable form without mutating live production behavior directly.",
            riskLevel: "low",
            verificationPlan:
              "Verify the promoted contract still preserves the existing chat, hands, and Telegram behavior when idle.",
            derivedFromSignalKeys: [signal.signalKey],
            evidence: signal.evidence,
            risk: {
              level: "low",
              summary:
                "Standardizing a good pattern is low risk if future waves preserve the current chat and maintenance APIs."
            },
            verification: {
              status: "pending",
              summary:
                "Verify the promoted contract still preserves the existing chat, hands, and Telegram behavior when idle."
            }
          },
          timestamp
        );
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
  const successEvidence = (metadata?.successEvidence as SuccessEvidenceRecord[]) || [];

  return {
    reflectionSessionId,
    sourceSessionId:
      typeof metadata?.reflectionFor === "string"
        ? metadata.reflectionFor
        : reflectionSessionId.slice(REFLECTION_PREFIX.length),
    sourceLastTx: typeof metadata?.sourceLastTx === "number" ? metadata.sourceLastTx : 0,
    improvementSignals,
    successEvidence
  };
}

function buildImprovementProposals(
  artifact: StoredReflectionArtifact,
  timestamp: string
): ImprovementProposalRecord[] {
  return buildImprovementCandidates(artifact.improvementSignals, timestamp).map((candidate) => ({
    ...candidate,
    proposalKey: `${artifact.reflectionSessionId}@${artifact.sourceLastTx}:${candidate.candidateKey}`,
    sourceReflectionSessionId: artifact.reflectionSessionId,
    sourceSessionId: artifact.sourceSessionId,
    sourceLastTx: artifact.sourceLastTx
  }));
}

function extractUserCorrectionMatches(session: SessionRecord): UserCorrectionMatch[] {
  const matches: UserCorrectionMatch[] = [];

  for (let index = 1; index < session.messages.length; index += 1) {
    const previousMessage = session.messages[index - 1];
    const currentMessage = session.messages[index];

    if (previousMessage.role !== "assistant" || currentMessage.role !== "user") {
      continue;
    }

    const pattern = classifyUserCorrection(currentMessage.content);
    if (!pattern) {
      continue;
    }

    matches.push({
      sessionId: session.id,
      assistantMessage: previousMessage,
      correctionMessage: currentMessage,
      pattern
    });
  }

  return matches;
}

function classifyUserCorrection(content: string): UserCorrectionPatternDefinition | null {
  const normalized = content.toLowerCase();
  const terms = tokenize(content);

  if (terms.some((term) => ["evidence", "proof", "verify", "cite", "source", "sources"].includes(term))) {
    return getUserCorrectionPattern("evidence-contract");
  }

  if (terms.some((term) => ["inspect", "search", "trace", "tool", "tools", "logs", "check"].includes(term))) {
    return getUserCorrectionPattern("tool-backed-investigation");
  }

  if (
    normalized.startsWith("no") ||
    normalized.includes("actually") ||
    normalized.includes("i meant") ||
    normalized.includes("instead") ||
    normalized.includes("rather than") ||
    normalized.includes("i said") ||
    normalized.includes("please answer")
  ) {
    return getUserCorrectionPattern("instruction-restatement");
  }

  return null;
}

function getUserCorrectionPattern(
  patternKey: UserCorrectionPatternKey
): UserCorrectionPatternDefinition | null {
  return USER_CORRECTION_PATTERNS.find((pattern) => pattern.patternKey === patternKey) ?? null;
}

function groupRepeatedUserCorrections(matches: UserCorrectionMatch[]) {
  const grouped = new Map<UserCorrectionPatternKey, UserCorrectionMatch[]>();

  for (const match of matches) {
    const current = grouped.get(match.pattern.patternKey) ?? [];
    current.push(match);
    grouped.set(match.pattern.patternKey, current);
  }

  return [...grouped.entries()]
    .map(([patternKey, groupedMatches]) => ({
      pattern: getUserCorrectionPattern(patternKey),
      matches: groupedMatches,
      distinctSessionCount: new Set(groupedMatches.map((match) => match.sessionId)).size
    }))
    .filter(
      (
        entry
      ): entry is {
        pattern: UserCorrectionPatternDefinition;
        matches: UserCorrectionMatch[];
        distinctSessionCount: number;
      } =>
        entry.pattern !== null &&
        entry.matches.length >= MIN_REPEATED_USER_CORRECTIONS &&
        entry.distinctSessionCount >= MIN_REPEATED_USER_CORRECTIONS
    );
}

function buildUserCorrectionSignal(
  pattern: UserCorrectionPatternDefinition,
  matches: UserCorrectionMatch[]
): ImprovementSignalRecord {
  const matchedSessionIds = [...new Set(matches.map((match) => match.sessionId))];
  const evidence = [
    buildMetricEvidence(
      `repeatedCorrectionCount=${matches.length}; matchedSessionCount=${matchedSessionIds.length}.`
    ),
    ...matches.slice(0, MAX_USER_CORRECTION_EVIDENCE).flatMap((match) => [
      buildMessageEvidence(
        match.assistantMessage,
        "Assistant response that immediately preceded the stored user correction."
      ),
      buildMessageEvidence(match.correctionMessage, "User follow-up that corrected the prior assistant response.")
    ])
  ];

  return {
    signalKey: pattern.signalKey,
    category: pattern.category,
    status: "active",
    summary: `${pattern.signalSummary} Matched ${matches.length} correction(s) across ${matchedSessionIds.length} session(s).`,
    evidence,
    risk: {
      level: pattern.riskLevel,
      summary: pattern.riskSummary
    },
    verification: {
      status: "pending",
      summary: pattern.verificationPlan
    },
    matchedSessionIds,
    repeatedCorrectionCount: matches.length
  };
}

function buildUserCorrectionProposal(
  signal: ImprovementSignalRecord,
  timestamp: string
): ImprovementProposalRecord {
  const pattern = USER_CORRECTION_PATTERNS.find((candidate) => candidate.signalKey === signal.signalKey);

  if (!pattern) {
    return {
      ...buildImprovementCandidateRecord(
        {
          candidateKey: "review-user-correction-pattern",
          summary: "Review the repeated user-correction pattern before considering any runtime change.",
          problemStatement: signal.summary,
          proposedAction: "Review the repeated user-correction pattern before considering any runtime change.",
          expectedBenefit: "Keeps user/operator corrections visible in the structured improvement queue.",
          riskLevel: "low",
          verificationPlan:
            "Verify any later action preserves the current chat, hands, and Telegram behavior when the change is idle or disabled.",
          derivedFromSignalKeys: [signal.signalKey],
          evidence: signal.evidence,
          risk: signal.risk,
          verification: signal.verification
        },
        timestamp
      ),
      proposalKey: `user-correction-miner:${signal.signalKey}:review`,
      sourceReflectionSessionId: "improvement:user-correction-miner",
      sourceSessionId: "user-correction-miner",
      sourceLastTx: 0,
      sourceHandId: "user-correction-miner"
    };
  }

  return {
    ...buildImprovementCandidateRecord(
      {
        candidateKey: pattern.candidateKey,
        summary: pattern.candidateSummary,
        problemStatement: signal.summary,
        proposedAction: pattern.proposedAction,
        expectedBenefit: pattern.expectedBenefit,
        riskLevel: pattern.riskLevel,
        verificationPlan: pattern.verificationPlan,
        derivedFromSignalKeys: [signal.signalKey],
        evidence: signal.evidence,
        risk: {
          level: pattern.riskLevel,
          summary: pattern.riskSummary
        },
        verification: {
          status: "pending",
          summary: pattern.verificationPlan
        }
      },
      timestamp
    ),
    proposalKey: `user-correction-miner:${pattern.patternKey}:${pattern.candidateKey}`,
    sourceReflectionSessionId: `improvement:user-correction:${pattern.patternKey}`,
    sourceSessionId: `user-correction-pattern:${pattern.patternKey}`,
    sourceLastTx: 0,
    sourceHandId: "user-correction-miner"
  };
}

export interface ImprovementCandidateSeed {
  candidateKey: string;
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
  complectionScore?: number;
}

export function buildImprovementCandidateRecord(
  input: ImprovementCandidateSeed,
  timestamp: string
): ImprovementCandidateRecord {
  // Phase 4: Governance Bouncer
  const gResult = applyGovernanceBouncer(input);
  const governedInput = {
    ...input,
    expectedBenefit: gResult.passed ? input.expectedBenefit : `${input.expectedBenefit} [GOVERNANCE: ${gResult.reason}]`,
    riskLevel: gResult.passed ? input.riskLevel : "high" as const
  };

  return {
    ...governedInput,
    status: "proposed",
    shadowEvaluation: {
      mode: "bounded-metadata-shadow",
      status: "pending",
      verdict: "pending",
      baselineSummary: input.problemStatement,
      candidateSummary: input.proposedAction,
      comparisonSummary:
        "Pending bounded shadow evaluation against persisted baseline evidence before any protected approval or promotion marker is allowed.",
      baselineEvidenceCount: input.evidence.length,
      baselineRiskLevel: input.risk.level,
      baselineVerificationStatus: input.verification.status,
      candidateRiskLevel: input.riskLevel,
      startedAt: null,
      completedAt: null
    },
    approval: {
      requiresProtectedApproval: true,
      status: "pending",
      approvedAt: null,
      rejectedAt: null,
      summary: "Protected operator approval is required before any promotion marker can be recorded."
    },
    promotion: {
      status: "not-promoted",
      promotedAt: null,
      rolledBackAt: null,
      productionMutation: "manual-only",
      liveMutationApplied: false,
      summary: "No production mutation is applied automatically; this first pass records lifecycle markers only."
    },
    votes: [],
    complectionScore: input.complectionScore ?? calculateComplectionScore(input),
    lifecycleHistory: [
      buildLifecycleHistoryEntry({
        action: "propose",
        actor: "hand-runtime",
        fromStatus: "none",
        toStatus: "proposed",
        timestamp,
        summary: `Structured improvement proposal ${input.candidateKey} was recorded for bounded review.`
      })
    ]
  };
}

function markShadowEvaluationStarted(
  proposal: ImprovementProposalRecord,
  timestamp: string
): ImprovementProposalRecord {
  return {
    ...proposal,
    status: "shadowing",
    shadowEvaluation: {
      ...proposal.shadowEvaluation,
      status: "pending",
      verdict: "pending",
      startedAt: timestamp
    },
    lifecycleHistory: [
      ...proposal.lifecycleHistory,
      buildLifecycleHistoryEntry({
        action: "start-shadow",
        actor: "hand-runtime",
        fromStatus: proposal.status,
        toStatus: "shadowing",
        timestamp,
        summary: `Bounded shadow evaluation started for ${proposal.proposalKey}.`
      })
    ]
  };
}

function completeShadowEvaluation(
  proposal: ImprovementProposalRecord,
  timestamp: string
): ImprovementProposalRecord {
  return {
    ...proposal,
    status: "awaiting-approval",
    shadowEvaluation: {
      ...proposal.shadowEvaluation,
      status: "completed",
      verdict: "awaiting-approval",
      comparisonSummary:
        "Compared the persisted baseline evidence against the bounded candidate plan in metadata-only shadow mode. The candidate may proceed to protected approval review, but no live production mutation was applied.",
      completedAt: timestamp
    },
    approval: {
      ...proposal.approval,
      status: "pending",
      summary: "Shadow evaluation completed. Protected operator approval is still required before promotion."
    },
    lifecycleHistory: [
      ...proposal.lifecycleHistory,
      buildLifecycleHistoryEntry({
        action: "complete-shadow",
        actor: "hand-runtime",
        fromStatus: proposal.status,
        toStatus: "awaiting-approval",
        timestamp,
        summary: `Bounded shadow evaluation completed for ${proposal.proposalKey}; candidate now awaits protected approval.`
      })
    ]
  };
}

function applyLifecycleAction(
  proposal: ImprovementProposalRecord,
  action: ImprovementLifecycleAction,
  timestamp: string,
  extra?: JsonObject
): ImprovementProposalRecord {
  switch (action) {
    case "pause": {
      if (proposal.status !== "awaiting-approval") {
        throw new Error(`Improvement proposal ${proposal.proposalKey} must reach protected review before it can be paused.`);
      }

      return {
        ...proposal,
        status: "paused",
        approval: {
          ...proposal.approval,
          status: "pending",
          summary: "Protected operator pause was recorded. Candidate remains on hold pending approval or rejection."
        },
        lifecycleHistory: [
          ...proposal.lifecycleHistory,
          buildLifecycleHistoryEntry({
            action,
            actor: "operator-route",
            fromStatus: proposal.status,
            toStatus: "paused",
            timestamp,
            summary: `Pause recorded for ${proposal.proposalKey}; candidate remains on hold pending operator review.`
          })
        ]
      };
    }
    case "approve": {
      if (proposal.status !== "awaiting-approval" && proposal.status !== "paused") {
        throw new Error(
          `Improvement proposal ${proposal.proposalKey} must complete shadow evaluation and await review before approval.`
        );
      }

      return {
        ...proposal,
        status: "approved",
        approval: {
          ...proposal.approval,
          status: "approved",
          approvedAt: timestamp,
          summary: "Protected operator approval was recorded for this candidate."
        },
        lifecycleHistory: [
          ...proposal.lifecycleHistory,
          buildLifecycleHistoryEntry({
            action,
            actor: "operator-route",
            fromStatus: proposal.status,
            toStatus: "approved",
            timestamp,
            summary: `Protected approval recorded for ${proposal.proposalKey}.`
          })
        ]
      };
    }
    case "promote": {
      if (proposal.status !== "approved") {
        throw new Error(`Improvement proposal ${proposal.proposalKey} must be approved before promotion.`);
      }

      return {
        ...proposal,
        status: "promoted",
        promotion: {
          ...proposal.promotion,
          status: "promoted",
          promotedAt: timestamp,
          summary:
            "Promotion marker recorded after protected approval. Live production mutation remains manual-only and was not applied automatically."
        },
        lifecycleHistory: [
          ...proposal.lifecycleHistory,
          buildLifecycleHistoryEntry({
            action,
            actor: "operator-route",
            fromStatus: proposal.status,
            toStatus: "promoted",
            timestamp,
            summary: `Promotion marker recorded for ${proposal.proposalKey}; live production behavior remains unchanged by default.`
          })
        ]
      };
    }
    case "reject": {
      if (proposal.status === "promoted" || proposal.status === "rolled-back" || proposal.status === "rejected") {
        throw new Error(`Improvement proposal ${proposal.proposalKey} cannot be rejected from status ${proposal.status}.`);
      }

      return {
        ...proposal,
        status: "rejected",
        approval: {
          ...proposal.approval,
          status: "rejected",
          rejectedAt: timestamp,
          summary: "Protected operator rejection was recorded for this candidate."
        },
        lifecycleHistory: [
          ...proposal.lifecycleHistory,
          buildLifecycleHistoryEntry({
            action,
            actor: "operator-route",
            fromStatus: proposal.status,
            toStatus: "rejected",
            timestamp,
            summary: `Rejection recorded for ${proposal.proposalKey}; candidate will not be promoted.`
          })
        ]
      };
    }
    case "rollback": {
      if (proposal.status !== "promoted") {
        throw new Error(`Improvement proposal ${proposal.proposalKey} must be promoted before rollback.`);
      }

      return {
        ...proposal,
        status: "rolled-back",
        promotion: {
          ...proposal.promotion,
          status: "rolled-back",
          rolledBackAt: timestamp,
          summary: "Rollback marker recorded for this candidate. No automatic live mutation had been applied."
        },
        lifecycleHistory: [
          ...proposal.lifecycleHistory,
          buildLifecycleHistoryEntry({
            action,
            actor: "operator-route",
            fromStatus: proposal.status,
            toStatus: "rolled-back",
            timestamp,
            summary: `Rollback marker recorded for ${proposal.proposalKey}.`
          })
        ]
      };
    }
    case "nexus-vote": {
      const voteData = extra?.vote as unknown as NexusVoteRecord;
      if (!voteData) return proposal;

      const votes = proposal.votes || [];
      const existingVoteIndex = votes.findIndex(v => v.voterNodeId === voteData.voterNodeId);
      const updatedVotes = [...votes];
      if (existingVoteIndex >= 0) {
        updatedVotes[existingVoteIndex] = voteData;
      } else {
        updatedVotes.push(voteData);
      }

      let updatedProposal: ImprovementProposalRecord = {
        ...proposal,
        votes: updatedVotes,
        lifecycleHistory: [
          ...proposal.lifecycleHistory,
          buildLifecycleHistoryEntry({
            action,
            actor: "operator-route",
            fromStatus: proposal.status,
            toStatus: proposal.status,
            timestamp,
            summary: `Nexus vote recorded from ${voteData.voterLabel} (${voteData.vote}).`
          })
        ]
      };

      // Auto-promotion logic: if > 50% weight approves, auto-promote if pending approval
      const totalWeight = updatedVotes.reduce((acc, v) => acc + v.weight, 0);
      const approveWeight = updatedVotes.filter(v => v.vote === "approve").reduce((acc, v) => acc + v.weight, 0);

      if (approveWeight > totalWeight / 2 && updatedProposal.status === "awaiting-approval") {
        updatedProposal = {
          ...updatedProposal,
          status: "approved",
          approval: {
            ...updatedProposal.approval,
            status: "approved",
            approvedAt: timestamp,
            summary: `Nexus consensus reached: ${approveWeight}/${totalWeight} weight approved.`
          }
        };
      }

      return updatedProposal;
    }
    default:
      return proposal;
  }
}

function buildLifecycleHistoryEntry(input: {
  action: ImprovementLifecycleAction;
  actor: ImprovementLifecycleEntryRecord["actor"];
  fromStatus: ImprovementLifecycleEntryRecord["fromStatus"];
  toStatus: ImprovementCandidateStatus;
  timestamp: string;
  summary: string;
}): ImprovementLifecycleEntryRecord {
  return {
    action: input.action,
    actor: input.actor,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    timestamp: input.timestamp,
    summary: input.summary
  };
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

function toImprovementProposalRecords(value: unknown): ImprovementProposalRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeImprovementProposalRecord(asJsonObject(entry)))
    .filter((entry): entry is ImprovementProposalRecord => entry !== null);
}

function normalizeImprovementProposalRecord(entry: JsonObject | null): ImprovementProposalRecord | null {
  if (
    !entry ||
    typeof entry.proposalKey !== "string" ||
    typeof entry.candidateKey !== "string" ||
    typeof entry.summary !== "string" ||
    typeof entry.problemStatement !== "string" ||
    typeof entry.proposedAction !== "string" ||
    typeof entry.expectedBenefit !== "string" ||
    typeof entry.verificationPlan !== "string" ||
    typeof entry.sourceReflectionSessionId !== "string" ||
    typeof entry.sourceSessionId !== "string" ||
    typeof entry.sourceLastTx !== "number"
  ) {
    return null;
  }

  const riskLevel = toImprovementRiskLevel(entry.riskLevel) ?? "medium";
  const risk = asJsonObject(entry.risk);
  const verification = asJsonObject(entry.verification);
  const status = toImprovementCandidateStatus(entry.status) ?? "proposed";

  return {
    proposalKey: entry.proposalKey,
    candidateKey: entry.candidateKey,
    status,
    summary: entry.summary,
    problemStatement: entry.problemStatement,
    proposedAction: entry.proposedAction,
    expectedBenefit: entry.expectedBenefit,
    riskLevel,
    verificationPlan: entry.verificationPlan,
    derivedFromSignalKeys: toStringArray(entry.derivedFromSignalKeys),
    evidence: toImprovementEvidenceRecords(entry.evidence),
    risk: {
      level: toImprovementRiskLevel(risk?.level) ?? riskLevel,
      summary: typeof risk?.summary === "string" ? risk.summary : `Candidate risk recorded as ${riskLevel}.`
    },
    verification: {
      status: toImprovementVerificationStatus(verification?.status) ?? "pending",
      summary:
        typeof verification?.summary === "string"
          ? verification.summary
          : "Verification remains pending until bounded shadow evaluation and protected operator review finish."
    },
    sourceReflectionSessionId: entry.sourceReflectionSessionId,
    sourceSessionId: entry.sourceSessionId,
    sourceLastTx: entry.sourceLastTx,
    shadowEvaluation: normalizeShadowEvaluation(asJsonObject(entry.shadowEvaluation), entry),
    approval: normalizeApproval(asJsonObject(entry.approval)),
    promotion: normalizePromotion(asJsonObject(entry.promotion)),
    votes: Array.isArray(entry.votes)
      ? (entry.votes.map((v) => asJsonObject(v)) as unknown as NexusVoteRecord[])
      : [],
    complectionScore: typeof entry.complectionScore === "number" ? entry.complectionScore : 0,
    lifecycleHistory: normalizeLifecycleHistory(entry.lifecycleHistory, status, entry.candidateKey)
  };
}

function normalizeShadowEvaluation(
  value: JsonObject | null,
  proposal: JsonObject
): ImprovementShadowEvaluationRecord {
  const baselineRiskLevel =
    toImprovementRiskLevel(asJsonObject(proposal.risk)?.level) ?? toImprovementRiskLevel(proposal.riskLevel) ?? "medium";
  const candidateRiskLevel = toImprovementRiskLevel(proposal.riskLevel) ?? baselineRiskLevel;

  return {
    mode: "bounded-metadata-shadow",
    status: value?.status === "completed" ? "completed" : "pending",
    verdict: value?.verdict === "awaiting-approval" ? "awaiting-approval" : "pending",
    baselineSummary:
      typeof value?.baselineSummary === "string"
        ? value.baselineSummary
        : typeof proposal.problemStatement === "string"
          ? proposal.problemStatement
          : "Persisted baseline evidence will be compared during bounded shadow evaluation.",
    candidateSummary:
      typeof value?.candidateSummary === "string"
        ? value.candidateSummary
        : typeof proposal.proposedAction === "string"
          ? proposal.proposedAction
          : "Candidate plan pending bounded shadow evaluation.",
    comparisonSummary:
      typeof value?.comparisonSummary === "string"
        ? value.comparisonSummary
        : "Pending bounded shadow evaluation against persisted baseline evidence before any promotion marker is allowed.",
    baselineEvidenceCount:
      typeof value?.baselineEvidenceCount === "number"
        ? value.baselineEvidenceCount
        : Array.isArray(proposal.evidence)
          ? proposal.evidence.length
          : 0,
    baselineRiskLevel,
    baselineVerificationStatus:
      toImprovementVerificationStatus(value?.baselineVerificationStatus) ??
      toImprovementVerificationStatus(asJsonObject(proposal.verification)?.status) ??
      "pending",
    candidateRiskLevel,
    startedAt: typeof value?.startedAt === "string" ? value.startedAt : null,
    completedAt: typeof value?.completedAt === "string" ? value.completedAt : null
  };
}

function normalizeApproval(value: JsonObject | null): ImprovementApprovalRecord {
  return {
    requiresProtectedApproval: true,
    status: value?.status === "approved" || value?.status === "rejected" ? value.status : "pending",
    approvedAt: typeof value?.approvedAt === "string" ? value.approvedAt : null,
    rejectedAt: typeof value?.rejectedAt === "string" ? value.rejectedAt : null,
    summary:
      typeof value?.summary === "string"
        ? value.summary
        : "Protected operator approval is required before any promotion marker can be recorded."
  };
}

function normalizePromotion(value: JsonObject | null): ImprovementPromotionRecord {
  return {
    status: value?.status === "promoted" || value?.status === "rolled-back" ? value.status : "not-promoted",
    promotedAt: typeof value?.promotedAt === "string" ? value.promotedAt : null,
    rolledBackAt: typeof value?.rolledBackAt === "string" ? value.rolledBackAt : null,
    productionMutation: "manual-only",
    liveMutationApplied: false,
    summary:
      typeof value?.summary === "string"
        ? value.summary
        : "No production mutation is applied automatically; this first pass records lifecycle markers only."
  };
}

function normalizeLifecycleHistory(
  value: unknown,
  status: ImprovementCandidateStatus,
  candidateKey: string
): ImprovementLifecycleEntryRecord[] {
  if (!Array.isArray(value)) {
    return [
      buildLifecycleHistoryEntry({
        action: "propose",
        actor: "hand-runtime",
        fromStatus: "none",
        toStatus: status,
        timestamp: new Date(0).toISOString(),
        summary: `Structured improvement proposal ${candidateKey} was recorded.`
      })
    ];
  }

  return value
    .map((entry) => asJsonObject(entry))
    .filter((entry): entry is JsonObject => entry !== null)
    .map((entry) => ({
      action: toImprovementLifecycleAction(entry.action) ?? "propose",
      actor: entry.actor === "operator-route" ? "operator-route" : "hand-runtime",
      fromStatus: toImprovementCandidateStatus(entry.fromStatus) ?? "none",
      toStatus: toImprovementCandidateStatus(entry.toStatus) ?? status,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : new Date(0).toISOString(),
      summary: typeof entry.summary === "string" ? entry.summary : `Improvement lifecycle updated for ${candidateKey}.`
    }));
}

function toImprovementEvidenceRecords(value: unknown): ImprovementEvidenceRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => asJsonObject(entry))
    .filter(
      (entry): entry is ImprovementEvidenceRecord =>
        entry !== null &&
        (entry.kind === "audit" || entry.kind === "message" || entry.kind === "tool-event" || entry.kind === "metric") &&
        typeof entry.summary === "string"
    )
    .map((entry) => ({
      kind: entry.kind,
      summary: entry.summary,
      eventId: typeof entry.eventId === "string" ? entry.eventId : null,
      tx: typeof entry.tx === "number" ? entry.tx : null,
      excerpt: typeof entry.excerpt === "string" ? entry.excerpt : null
    }));
}

function toImprovementRiskLevel(value: unknown): ImprovementRiskLevel | null {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

function toImprovementVerificationStatus(value: unknown): ImprovementVerificationStatus | null {
  return value === "pending" || value === "verified" || value === "not-needed" ? value : null;
}

function toImprovementCandidateStatus(value: unknown): ImprovementCandidateStatus | null {
  return value === "proposed" ||
    value === "shadowing" ||
    value === "awaiting-approval" ||
    value === "paused" ||
    value === "approved" ||
    value === "promoted" ||
    value === "rejected" ||
    value === "rolled-back"
    ? value
    : null;
}

function toImprovementLifecycleAction(value: unknown): ImprovementLifecycleAction | null {
  return value === "propose" ||
    value === "start-shadow" ||
    value === "complete-shadow" ||
    value === "pause" ||
    value === "approve" ||
    value === "promote" ||
    value === "reject" ||
    value === "rollback"
    ? value
    : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
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

interface GovernanceResult {
  passed: boolean;
  reason?: string;
}

export function applyGovernanceBouncer(candidate: ImprovementCandidateSeed): GovernanceResult {
  const complectionScore = calculateComplectionScore(candidate);
  
  // 🧙🏾‍♂️ Rich Hickey: Complexity is the enemy.
  const scoreThreshold = 60;
  
  if (complectionScore > scoreThreshold) {
    return { 
      passed: false, 
      reason: `Complexity threshold exceeded (Score: ${complectionScore}). Proposal introduces too much complection.` 
    };
  }

  if (candidate.evidence.length === 0) {
    return { passed: false, reason: "Lack of provenance. No evidence provided for candidate." };
  }

  return { passed: true };
}

/**
 * 🧙🏾‍♂️ ComplectionEngine: Quantifying Complexity
 * Based on Rich Hickey's "Simple vs Easy"
 */
function calculateComplectionScore(candidate: ImprovementCandidateSeed): number {
  let score = 0;
  const text = (candidate.proposedAction + " " + candidate.summary + " " + candidate.problemStatement).toLowerCase();

  // 1. Structural Complection (Wrappers, Proxies, Layers)
  if (text.includes("proxy")) score += 30;
  if (text.includes("wrapper")) score += 25;
  if (text.includes("layer")) score += 20;
  if (text.includes("intercept")) score += 15;

  // 2. Statefulness (New attributes, storage, cache)
  if (text.includes("cache")) score += 20;
  if (text.includes("store")) score += 15;
  if (text.includes("state")) score += 10;
  if (text.includes("persist")) score += 10;

  // 3. Dependency Fan-out (Multiple entities)
  if (candidate.derivedFromSignalKeys.length > 5) score += 15;
  if (candidate.evidence.length > 10) score += 5; // Large evidence might imply broad impact

  // 4. Mitigation (De-complecting bonus)
  if (text.includes("de-complect") || text.includes("simplify") || text.includes("refactor")) {
    score -= 20;
  }

  return Math.max(0, score);
}

class GovernanceBouncer {
  constructor(private readonly database: D1Database) {}

  async filterProposals(proposals: ImprovementProposalRecord[]): Promise<ImprovementProposalRecord[]> {
    return proposals.filter(p => {
       const result = applyGovernanceBouncer(p);
       if (!result.passed) {
          console.warn(`Governance Bouncer rejected proposal ${p.proposalKey}: ${result.reason}`);
       }
       return result.passed;
    });
  }
}

export const scheduledMaintenanceCrons = {
  maintenance: MAINTENANCE_CRON,
  morningBriefing: MORNING_BRIEFING_CRON
} as const;

/**
 * 🧙🏾‍♂️ Rich Hickey: Synthetic Reflection Loop
 * Port of the GSV (Generative Software Verification) Synthetic Data Pipeline.
 * De-complects live performance from robustness testing by generating
 * failure edge cases and storing them as global patterns.
 */
export async function runSyntheticReflectionLoop(input: {
  env: Env;
  timestamp?: string;
}): Promise<{
  generatedPatternCount: number;
  syntheticScenarios: string[];
}> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const db = input.env.AARONDB;

  // 1. Fetch Success Trajectories
  const successes = await db
    .prepare(
      `
    SELECT value_json FROM aarondb_facts 
    WHERE attribute = 'summary' AND toolName = 'session-reflection'
    AND operation = 'assert'
    ORDER BY tx DESC LIMIT 10
  `
    )
    .all<{ value_json: string }>();

  if (successes.results.length === 0) {
    return { generatedPatternCount: 0, syntheticScenarios: [] };
  }

  // 2. Generate Synthetic Failure Scenarios via Workers AI
  const prompt = `
    Analyze these successful AaronClaw trajectories and synthesize 3 high-probability "Failure Edge Cases" 
    or "Chaos Scenarios" where these structures might fail.
    
    Successful Trajectories:
    ${successes.results.map((r) => r.value_json).join("\n- ")}
    
    Output format: JSON array of objects with { patternKey, problemStatement, proposedAction, expectedBenefit, category: "synthetic-shadow" }
    Focus on: Latency spikes, identity-leakage, and semantic drift.
  `;

  const response = await input.env.AI.run("@cf/meta/llama-3-8b-instruct", {
    messages: [
      { role: "system", content: "You are the AaronClaw Reflection Engine. Embody Rich Hickey's philosophy of simplicity and robustness." },
      { role: "user", content: prompt }
    ]
  });

  // Extract JSON from response (handling potential markdown wrapping)
  const content = response.response || response.text || "";
  const jsonMatch = content.match(/\[\s*\{.*\}\s*\]/s);
  if (!jsonMatch) {
    console.error("Failed to parse synthetic patterns from AI response");
    return { generatedPatternCount: 0, syntheticScenarios: [] };
  }

  const syntheticPatterns = JSON.parse(jsonMatch[0]) as any[];
  let generatedPatternCount = 0;

  // 3. Record as global_patterns
  for (const pattern of syntheticPatterns) {
    try {
      await db
        .prepare(
          `
        INSERT INTO global_patterns (patternKey, category, problemStatement, proposedAction, expectedBenefit)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(patternKey) DO UPDATE SET
          updatedAt = CURRENT_TIMESTAMP,
          contributionCount = contributionCount + 1
      `
        )
        .bind(
          pattern.patternKey || `synthetic:${Math.random().toString(36).slice(2, 9)}`,
          pattern.category || "synthetic-shadow",
          pattern.problemStatement,
          pattern.proposedAction,
          pattern.expectedBenefit
        )
        .run();
      generatedPatternCount++;
    } catch (e) {
      console.error(`Failed to record synthetic pattern: ${e}`);
    }
  }

  return {
    generatedPatternCount,
    syntheticScenarios: syntheticPatterns.map((p) => p.problemStatement)
  };
}