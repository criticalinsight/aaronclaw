import {
  buildImprovementCandidateRecord,
  IMPROVEMENT_PROPOSAL_SESSION_ID,
  listRecentStoredReflectionArtifacts,
  type ImprovementEvidenceRecord,
  type ImprovementProposalRecord,
  runScheduledImprovementProposalReview,
  runScheduledImprovementShadowEvaluation,
  runScheduledUserCorrectionMining,
  runScheduledMaintenance,
  scheduledMaintenanceCrons
} from "./reflection-engine";
import { runScheduledDocsDriftReview, type DocsDriftFinding } from "./docs-drift";
import { runProviderHealthWatchdog, type ProviderHealthFinding } from "./provider-health-watchdog";
import { AaronDbEdgeSessionRepository, type JsonObject, type ToolEvent } from "./session-state";
import { buildToolAuditRecord } from "./tool-policy";

import { bundledHandDefinitions, type BundledHandDefinition } from "./hands-catalog";

const HAND_SESSION_PREFIX = "hand:";
const HAND_LIFECYCLE_TOOL = "hand-lifecycle";
const HAND_RUN_TOOL = "hand-run";
const MAX_RUN_HISTORY = 10;
const MAX_AUDIT_HISTORY = 10;
const MAX_REGRESSION_REFLECTIONS = 5;
const MAX_FINDING_EVIDENCE = 4;
const FALLBACK_SPIKE_THRESHOLD = 2;
const DEGRADED_TOOL_SPIKE_THRESHOLD = 2;
const FAILED_HAND_RUN_THRESHOLD = 1;

const bundledHands = bundledHandDefinitions;

type HandLifecycleAction = "activate" | "pause";
type HandRunStatus = "succeeded" | "failed";

export interface RegressionFindingRecord extends JsonObject {
  findingKey: string;
  category: "fallback-spike" | "blocked-tool-spike" | "failed-hand-run";
  candidateKey: string;
  summary: string;
  threshold: number;
  observedCount: number;
  sourceSessionId: string;
  sourceReflectionSessionId: string;
  sourceLastTx: number;
  evidence: ImprovementEvidenceRecord[];
}

interface RegressionWatchReviewResult {
  proposalSessionId: string;
  reviewedReflectionCount: number;
  reviewedSignalCount: number;
  generatedProposalCount: number;
  skippedDuplicateProposalCount: number;
  findingCount: number;
  findings: RegressionFindingRecord[];
}

export type HandFindingRecord = RegressionFindingRecord | DocsDriftFinding;

export interface HandRunRecord {
  timestamp: string;
  status: HandRunStatus;
  cron: string | null;
  summary: string;
  maintenanceSessionId: string | null;
  proposalSessionId: string | null;
  reviewedSessionCount: number;
  reflectedSessionCount: number;
  reviewedSignalCount: number;
  reviewedReflectionCount: number;
  correctionSignalCount: number;
  matchedCorrectionCount: number;
  generatedProposalCount: number;
  evaluatedProposalCount: number;
  awaitingApprovalCount: number;
  skippedDuplicateProposalCount: number;
  reviewedDocumentCount: number;
  reviewedClaimCount: number;
  findingCount: number;
  findings: HandFindingRecord[];
  signalSessionId: string | null;
  healthyCount: number;
  degradedCount: number;
  unavailableCount: number;
  unknownCount: number;
  providerHealthFindings: ProviderHealthFinding[];
  error: string | null;
}

export interface HandAuditRecord {
  timestamp: string;
  toolName: string;
  action: string | null;
  summary: string;
  outcome: "succeeded" | "blocked" | "failed" | null;
  policy: string | null;
  capability: string | null;
  actor: string | null;
  detail: string | null;
  cron: string | null;
  maintenanceSessionId: string | null;
}

export interface BundledHandState {
  id: BundledHandDefinition["id"];
  label: string;
  description: string;
  implementation: BundledHandDefinition["implementation"];
  runtime: string;
  scheduleCrons: string[];
  status: "active" | "paused";
  persisted: boolean;
  updatedAt: string | null;
  lastLifecycleAction: HandLifecycleAction | null;
  latestRun: HandRunRecord | null;
  recentRuns: HandRunRecord[];
  recentAudit: HandAuditRecord[];
}

export async function listBundledHands(input: {
  env: Pick<Env, "AARONDB">;
}): Promise<BundledHandState[]> {
  const hands = await Promise.all(
    bundledHands.map((hand) => readBundledHandState({ env: input.env, handId: hand.id }))
  );

  return hands.filter((hand): hand is BundledHandState => hand !== null);
}

export async function readBundledHandState(input: {
  env: Pick<Env, "AARONDB">;
  handId: string;
}): Promise<BundledHandState | null> {
  const definition = getBundledHandDefinition(input.handId);

  if (!definition) {
    return null;
  }

  const repository = new AaronDbEdgeSessionRepository(input.env.AARONDB, buildHandSessionId(definition.id));
  const session = await repository.getSession();

  return buildBundledHandState(definition, session?.toolEvents ?? []);
}

export async function setBundledHandLifecycle(input: {
  env: Pick<Env, "AARONDB">;
  handId: string;
  action: HandLifecycleAction;
  timestamp?: string;
}): Promise<BundledHandState | null> {
  const definition = getBundledHandDefinition(input.handId);

  if (!definition) {
    return null;
  }

  const timestamp = input.timestamp ?? new Date().toISOString();
  const repository = await ensureHandRepository(input.env, definition, timestamp);
  const status = input.action === "activate" ? "active" : "paused";

  await repository.appendToolEvent({
    timestamp,
    toolName: HAND_LIFECYCLE_TOOL,
    summary: `${definition.label} ${status}.`,
    metadata: {
      action: input.action,
      handId: definition.id,
      runtime: definition.runtime,
      scheduleCrons: [...definition.scheduleCrons],
      status,
      audit: buildToolAuditRecord({
        toolId: "hand-lifecycle",
        actor: "operator-route",
        scope: "hand",
        outcome: "succeeded",
        timestamp,
        handId: definition.id,
        detail: `${definition.label} was ${status} through the protected operator route.`,
        extra: {
          action: input.action,
          runtime: definition.runtime
        }
      })
    }
  });

  return readBundledHandState({ env: input.env, handId: definition.id });
}

export async function runScheduledHands(input: {
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
}): Promise<{
  cron: string;
  timestamp: string;
  triggeredHandIds: string[];
}> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const triggeredHandIds: string[] = [];

  for (const definition of bundledHands) {
    if (!definition.scheduleCrons.some((cron) => cron === input.cron)) {
      continue;
    }

    const state = await readBundledHandState({ env: input.env, handId: definition.id });
    if (state?.status !== "active") {
      continue;
    }

    await executeBundledHandRun({
      env: input.env,
      definition,
      cron: input.cron,
      timestamp
    });
    triggeredHandIds.push(definition.id);
  }

  return {
    cron: input.cron,
    timestamp,
    triggeredHandIds
  };
}

export function isSyntheticHandSessionId(sessionId: string): boolean {
  return sessionId.startsWith(HAND_SESSION_PREFIX);
}

function getBundledHandDefinition(handId: string): BundledHandDefinition | null {
  return bundledHands.find((hand) => hand.id === handId) ?? null;
}

function buildHandSessionId(handId: string): string {
  return `${HAND_SESSION_PREFIX}${handId}`;
}

async function ensureHandRepository(
  env: Pick<Env, "AARONDB">,
  definition: BundledHandDefinition,
  timestamp: string
): Promise<AaronDbEdgeSessionRepository> {
  const repository = new AaronDbEdgeSessionRepository(env.AARONDB, buildHandSessionId(definition.id));
  await repository.createSession(timestamp);
  return repository;
}

async function executeBundledHandRun(input: {
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
  definition: BundledHandDefinition;
  cron: string;
  timestamp: string;
}): Promise<void> {
  const repository = await ensureHandRepository(input.env, input.definition, input.timestamp);

  try {
    if (input.definition.implementation === "scheduled-maintenance") {
      const maintenance = await runScheduledMaintenance({
        env: input.env,
        cron: input.cron,
        timestamp: input.timestamp
      });

      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} ran for cron ${input.cron} and reused the scheduled maintenance path.`,
        metadata: {
          action: "run",
          cron: input.cron,
          handId: input.definition.id,
          maintenanceSessionId: maintenance.maintenanceSessionId,
          reflectedSessionCount: maintenance.reflectedSessionIds.length,
          reviewedSessionCount: maintenance.reviewedSessionIds.length,
          status: "succeeded",
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} completed successfully for cron ${input.cron}.`,
            extra: {
              cron: input.cron,
              maintenanceSessionId: maintenance.maintenanceSessionId,
              reflectedSessionCount: maintenance.reflectedSessionIds.length,
              reviewedSessionCount: maintenance.reviewedSessionIds.length
            }
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "improvement-hand") {
      const proposalReview = await runScheduledImprovementProposalReview({
        env: input.env,
        cron: input.cron,
        timestamp: input.timestamp
      });
      const shadowEvaluation = await runScheduledImprovementShadowEvaluation({
        env: input.env,
        cron: input.cron,
        timestamp: input.timestamp
      });

      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} reviewed ${proposalReview.reviewedSignalCount} stored signal(s), wrote ${proposalReview.generatedProposalCount} structured proposal(s), and completed bounded shadow evaluation for ${shadowEvaluation.evaluatedProposalCount} proposal(s) for cron ${input.cron}.`,
        metadata: {
          action: "run",
          awaitingApprovalCount: shadowEvaluation.awaitingApprovalCount,
          cron: input.cron,
          evaluatedProposalCount: shadowEvaluation.evaluatedProposalCount,
          generatedProposalCount: proposalReview.generatedProposalCount,
          handId: input.definition.id,
          proposalSessionId: proposalReview.proposalSessionId,
          reviewedReflectionCount: proposalReview.reviewedReflectionSessionIds.length,
          reviewedSignalCount: proposalReview.reviewedSignalCount,
          skippedDuplicateProposalCount: proposalReview.skippedDuplicateProposalCount,
          status: "succeeded",
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} completed successfully for cron ${input.cron}.`,
            extra: {
              awaitingApprovalCount: shadowEvaluation.awaitingApprovalCount,
              cron: input.cron,
              evaluatedProposalCount: shadowEvaluation.evaluatedProposalCount,
              generatedProposalCount: proposalReview.generatedProposalCount,
              proposalSessionId: proposalReview.proposalSessionId,
              reviewedReflectionCount: proposalReview.reviewedReflectionSessionIds.length,
              reviewedSignalCount: proposalReview.reviewedSignalCount,
              skippedDuplicateProposalCount: proposalReview.skippedDuplicateProposalCount
            }
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "user-correction-miner") {
      const correctionReview = await runScheduledUserCorrectionMining({
        env: input.env,
        cron: input.cron,
        timestamp: input.timestamp
      });

      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} mined ${correctionReview.correctionSignalCount} repeated correction pattern(s), matched ${correctionReview.matchedCorrectionCount} correction(s), and wrote ${correctionReview.generatedProposalCount} structured proposal(s) for cron ${input.cron}.`,
        metadata: {
          action: "run",
          correctionSignalCount: correctionReview.correctionSignalCount,
          correctionSignals: correctionReview.correctionSignals,
          cron: input.cron,
          generatedProposalCount: correctionReview.generatedProposalCount,
          handId: input.definition.id,
          matchedCorrectionCount: correctionReview.matchedCorrectionCount,
          proposalSessionId: correctionReview.proposalSessionId,
          reviewedSessionCount: correctionReview.reviewedSessionIds.length,
          reviewedSessionIds: correctionReview.reviewedSessionIds,
          reviewedSignalCount: correctionReview.correctionSignalCount,
          skippedDuplicateProposalCount: correctionReview.skippedDuplicateProposalCount,
          status: "succeeded",
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} completed successfully for cron ${input.cron}.`,
            extra: {
              correctionSignalCount: correctionReview.correctionSignalCount,
              cron: input.cron,
              generatedProposalCount: correctionReview.generatedProposalCount,
              matchedCorrectionCount: correctionReview.matchedCorrectionCount,
              proposalSessionId: correctionReview.proposalSessionId,
              reviewedSessionCount: correctionReview.reviewedSessionIds.length,
              skippedDuplicateProposalCount: correctionReview.skippedDuplicateProposalCount
            }
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "regression-watch") {
      const regressionReview = await runScheduledRegressionWatch({
        env: input.env,
        cron: input.cron,
        timestamp: input.timestamp
      });

      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `Regression Watch reviewed ${regressionReview.reviewedSignalCount} stored signal(s) and wrote ${regressionReview.generatedProposalCount} structured proposal(s) for cron ${input.cron}.`,
        metadata: {
          action: "run",
          cron: input.cron,
          generatedProposalCount: regressionReview.generatedProposalCount,
          handId: input.definition.id,
          proposalSessionId: regressionReview.proposalSessionId,
          reviewedSignalCount: regressionReview.reviewedSignalCount,
          status: "succeeded",
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} completed successfully for cron ${input.cron}.`,
            extra: {
              cron: input.cron,
              generatedProposalCount: regressionReview.generatedProposalCount,
              proposalSessionId: regressionReview.proposalSessionId,
              reviewedSignalCount: regressionReview.reviewedSignalCount
            }
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "docs-drift") {
      const docsDriftReview = await runScheduledDocsDriftReview({
        env: input.env,
        cron: input.cron
      });

      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: docsDriftReview.summary,
        metadata: {
          action: "run",
          cron: input.cron,
          findingCount: docsDriftReview.findingCount,
          findings: docsDriftReview.findings,
          handId: input.definition.id,
          reviewedClaimCount: docsDriftReview.reviewedClaimCount,
          reviewedDocumentCount: docsDriftReview.reviewedDocumentCount,
          status: "succeeded",
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: docsDriftReview.summary,
            extra: {
              cron: input.cron,
              findingCount: docsDriftReview.findingCount,
              reviewedClaimCount: docsDriftReview.reviewedClaimCount,
              reviewedDocumentCount: docsDriftReview.reviewedDocumentCount
            }
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "provider-health-watchdog") {
      const healthReport = await runProviderHealthWatchdog({
        env: input.env,
        cron: input.cron,
        timestamp: input.timestamp
      });

      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} recorded ${healthReport.degradedCount + healthReport.unavailableCount} degraded/unavailable finding(s) across provider, model, key, and route health for cron ${input.cron}.`,
        metadata: {
          action: "run",
          cron: input.cron,
          degradedCount: healthReport.degradedCount,
          handId: input.definition.id,
          healthyCount: healthReport.healthyCount,
          providerHealthFindings: healthReport.findings,
          signalSessionId: healthReport.signalSessionId,
          status: "succeeded",
          unavailableCount: healthReport.unavailableCount,
          unknownCount: healthReport.unknownCount,
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} completed successfully for cron ${input.cron}.`,
            extra: {
              cron: input.cron,
              degradedCount: healthReport.degradedCount,
              healthyCount: healthReport.healthyCount,
              signalSessionId: healthReport.signalSessionId,
              unavailableCount: healthReport.unavailableCount,
              unknownCount: healthReport.unknownCount
            }
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "ttl-garbage-collector") {
      const report = await runTtlGarbageCollector(input.env);
      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} purged ${report.deletedCount} old fact(s) (TTL=${report.ttlDays}d) for cron ${input.cron}.`,
        metadata: {
          action: "run",
          cron: input.cron,
          deletedCount: report.deletedCount,
          handId: input.definition.id,
          status: "succeeded",
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} purged ${report.deletedCount} old fact(s).`
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "orphan-fact-cleanup") {
      const report = await runOrphanFactCleanup(input.env);
      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} identified and removed ${report.deletedCount} orphaned fact(s) across ${report.orphanedReflectionCount} reflection session(s) for cron ${input.cron}.`,
        metadata: {
          action: "run",
          cron: input.cron,
          deletedCount: report.deletedCount,
          handId: input.definition.id,
          orphans: report.orphans,
          status: "succeeded",
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} removed ${report.deletedCount} orphaned fact(s).`
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "daily-briefing-generator") {
      const briefing = await runDailyBriefingGenerator(input.env);
      const reviewedSessionIds = (briefing.reviewedSessionIds as string[]) ?? [];
      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} compiled the daily briefing from ${reviewedSessionIds.length} session(s) for cron ${input.cron}.`,
        metadata: {
          action: "run",
          briefingSessionId: briefing.maintenanceSessionId,
          cron: input.cron,
          handId: input.definition.id,
          reviewedSessionCount: reviewedSessionIds.length,
          status: "succeeded",
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} compiled daily briefing successfully.`
          })
        }
      });
      return;
    }

    // Generic fallback for Phase 2 Scaffolding (handles all other 41 implementations)
    await repository.appendToolEvent({
      timestamp: input.timestamp,
      toolName: HAND_RUN_TOOL,
      summary: `${input.definition.label} executed (Phase 2 Scaffolding). No functional effects recorded.`,
      metadata: {
        action: "run",
        cron: input.cron,
        handId: input.definition.id,
        status: "succeeded",
        note: "This hand implementation is wired for dispatch but lacks specialized heuristic logic in this version.",
        audit: buildToolAuditRecord({
          toolId: "hand-run",
          actor: "hand-runtime",
          scope: "hand",
          outcome: "succeeded",
          timestamp: input.timestamp,
          handId: input.definition.id,
          detail: `${input.definition.label} dispatched successfully (Scaffolding Pass).`
        })
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown hand execution failure";

    await repository.appendToolEvent({
      timestamp: input.timestamp,
      toolName: HAND_RUN_TOOL,
      summary: `${input.definition.label} failed for cron ${input.cron}: ${message}`,
      metadata: {
        action: "run",
        cron: input.cron,
        error: message,
        handId: input.definition.id,
        status: "failed",
        audit: buildToolAuditRecord({
          toolId: "hand-run",
          actor: "hand-runtime",
          scope: "hand",
          outcome: "failed",
          timestamp: input.timestamp,
          handId: input.definition.id,
          detail: `${input.definition.label} failed for cron ${input.cron}.`,
          extra: {
            cron: input.cron,
            error: message
          }
        })
      }
    });

    throw error;
  }
}

async function runScheduledRegressionWatch(input: {
  env: Pick<Env, "AARONDB">;
  cron: string;
  timestamp: string;
}): Promise<RegressionWatchReviewResult> {
  const storedReflections = await listRecentStoredReflectionArtifacts(
    input.env.AARONDB,
    MAX_REGRESSION_REFLECTIONS
  );
  const reviewedSignalCount = storedReflections.reduce(
    (total, artifact) => total + artifact.improvementSignals.length,
    0
  );
  const failedHandRuns = await listRecentFailedHandRuns({ env: input.env, excludedHandId: "regression-watch" });
  const findings = buildRegressionFindings(storedReflections, failedHandRuns);
  const proposals = findings.map((finding) => toRegressionImprovementProposal(finding));
  const proposalRepository = new AaronDbEdgeSessionRepository(
    input.env.AARONDB,
    IMPROVEMENT_PROPOSAL_SESSION_ID
  );
  const existingProposalKeys = getStoredProposalKeys((await proposalRepository.getSession())?.toolEvents ?? []);
  const freshProposals = proposals.filter((proposal) => !existingProposalKeys.has(proposal.proposalKey));

  if (freshProposals.length > 0) {
    await proposalRepository.createSession(input.timestamp);
    await proposalRepository.appendToolEvent({
      timestamp: input.timestamp,
      toolName: "regression-watch-review",
      summary: `Regression Watch reviewed ${storedReflections.length} stored reflection session(s), recorded ${findings.length} bounded finding(s), and wrote ${freshProposals.length} structured proposal(s).`,
      metadata: {
        cron: input.cron,
        findingCount: findings.length,
        findings,
        generatedProposalCount: freshProposals.length,
        proposals: freshProposals,
        reviewedReflectionCount: storedReflections.length,
        reviewedSignalCount,
        skippedDuplicateProposalCount: proposals.length - freshProposals.length,
        audit: buildToolAuditRecord({
          toolId: "regression-watch-review",
          actor: "hand-runtime",
          scope: "hand",
          outcome: "succeeded",
          timestamp: input.timestamp,
          handId: "regression-watch",
          sessionId: IMPROVEMENT_PROPOSAL_SESSION_ID,
          detail: `Regression Watch wrote ${freshProposals.length} structured proposal(s) from ${findings.length} bounded finding(s).`,
          extra: {
            cron: input.cron,
            findingCount: findings.length,
            generatedProposalCount: freshProposals.length,
            reviewedReflectionCount: storedReflections.length,
            reviewedSignalCount,
            skippedDuplicateProposalCount: proposals.length - freshProposals.length
          }
        })
      }
    });
  }

  return {
    proposalSessionId: IMPROVEMENT_PROPOSAL_SESSION_ID,
    reviewedReflectionCount: storedReflections.length,
    reviewedSignalCount,
    generatedProposalCount: freshProposals.length,
    skippedDuplicateProposalCount: proposals.length - freshProposals.length,
    findingCount: findings.length,
    findings
  };
}

async function listRecentFailedHandRuns(input: {
  env: Pick<Env, "AARONDB">;
  excludedHandId: string;
}): Promise<Array<{ handId: string; event: ToolEvent }>> {
  const failedRuns: Array<{ handId: string; event: ToolEvent }> = [];

  for (const definition of bundledHands) {
    if (definition.id === input.excludedHandId) {
      continue;
    }

    const session = await new AaronDbEdgeSessionRepository(
      input.env.AARONDB,
      buildHandSessionId(definition.id)
    ).getSession();

    for (const event of session?.toolEvents ?? []) {
      if (event.toolName === HAND_RUN_TOOL && event.metadata?.status === "failed") {
        failedRuns.push({ handId: definition.id, event });
      }
    }
  }

  return failedRuns.sort((left, right) => right.event.createdAt.localeCompare(left.event.createdAt));
}

function buildRegressionFindings(
  storedReflections: Awaited<ReturnType<typeof listRecentStoredReflectionArtifacts>>,
  failedHandRuns: Array<{ handId: string; event: ToolEvent }>
): RegressionFindingRecord[] {
  const fallbackMatches = storedReflections.flatMap((artifact) =>
    artifact.improvementSignals
      .filter((signal) => signal.signalKey === "assistant-fallback-observed")
      .map((signal) => ({ artifact, signal }))
  );
  const degradedMatches = storedReflections.flatMap((artifact) =>
    artifact.improvementSignals
      .filter((signal) => signal.signalKey === "degraded-tool-audit")
      .map((signal) => ({ artifact, signal }))
  );
  const findings: RegressionFindingRecord[] = [];

  if (fallbackMatches.length >= FALLBACK_SPIKE_THRESHOLD) {
    const latest = fallbackMatches[0] ?? fallbackMatches[fallbackMatches.length - 1];

    findings.push({
      findingKey: "fallback-spike",
      category: "fallback-spike",
      candidateKey: "investigate-fallback-spike",
      summary: `Fallback behavior spiked across ${fallbackMatches.length} of the last ${storedReflections.length} stored reflection session(s).`,
      threshold: FALLBACK_SPIKE_THRESHOLD,
      observedCount: fallbackMatches.length,
      sourceSessionId: latest.artifact.sourceSessionId,
      sourceReflectionSessionId: latest.artifact.reflectionSessionId,
      sourceLastTx: latest.artifact.sourceLastTx,
      evidence: buildSignalFindingEvidence({
        matches: fallbackMatches,
        metricSummary: `fallbackSignalCount=${fallbackMatches.length}; threshold=${FALLBACK_SPIKE_THRESHOLD}; reviewedReflectionCount=${storedReflections.length}.`
      })
    });
  }

  if (degradedMatches.length >= DEGRADED_TOOL_SPIKE_THRESHOLD) {
    const latest = degradedMatches[0] ?? degradedMatches[degradedMatches.length - 1];

    findings.push({
      findingKey: "blocked-tool-spike",
      category: "blocked-tool-spike",
      candidateKey: "investigate-blocked-tool-spike",
      summary: `Blocked or failed tool audits appeared in ${degradedMatches.length} of the last ${storedReflections.length} stored reflection session(s).`,
      threshold: DEGRADED_TOOL_SPIKE_THRESHOLD,
      observedCount: degradedMatches.length,
      sourceSessionId: latest.artifact.sourceSessionId,
      sourceReflectionSessionId: latest.artifact.reflectionSessionId,
      sourceLastTx: latest.artifact.sourceLastTx,
      evidence: buildSignalFindingEvidence({
        matches: degradedMatches,
        metricSummary: `degradedToolSignalCount=${degradedMatches.length}; threshold=${DEGRADED_TOOL_SPIKE_THRESHOLD}; reviewedReflectionCount=${storedReflections.length}.`
      })
    });
  }

  if (failedHandRuns.length >= FAILED_HAND_RUN_THRESHOLD) {
    const latest = failedHandRuns[0];

    findings.push({
      findingKey: "failed-hand-run",
      category: "failed-hand-run",
      candidateKey: "stabilize-failed-hand-run",
      summary: `Recent bundled hand history contains ${failedHandRuns.length} failed run(s), indicating the autonomous path needs operator review.`,
      threshold: FAILED_HAND_RUN_THRESHOLD,
      observedCount: failedHandRuns.length,
      sourceSessionId: buildHandSessionId(latest.handId),
      sourceReflectionSessionId: buildHandSessionId(latest.handId),
      sourceLastTx: latest.event.tx,
      evidence: [
        buildMetricEvidence(
          `failedHandRunCount=${failedHandRuns.length}; threshold=${FAILED_HAND_RUN_THRESHOLD}.`
        ),
        ...failedHandRuns.slice(0, MAX_FINDING_EVIDENCE - 1).map(({ handId, event }) =>
          buildToolEventEvidence(event, `Bundled hand ${handId} recorded a failed scheduled run.`)
        )
      ]
    });
  }

  return findings;
}

function buildSignalFindingEvidence(input: {
  matches: Array<{
    artifact: Awaited<ReturnType<typeof listRecentStoredReflectionArtifacts>>[number];
    signal: { evidence: ImprovementEvidenceRecord[] };
  }>;
  metricSummary: string;
}): ImprovementEvidenceRecord[] {
  const evidence: ImprovementEvidenceRecord[] = [buildMetricEvidence(input.metricSummary)];

  for (const match of input.matches.slice(0, 2)) {
    evidence.push(
      buildMetricEvidence(
        `sourceReflectionSessionId=${match.artifact.reflectionSessionId}; sourceSessionId=${match.artifact.sourceSessionId}; sourceLastTx=${match.artifact.sourceLastTx}.`
      )
    );

    for (const signalEvidence of match.signal.evidence) {
      if (evidence.length >= MAX_FINDING_EVIDENCE) {
        return evidence;
      }

      evidence.push(signalEvidence);
    }

    if (evidence.length >= MAX_FINDING_EVIDENCE) {
      return evidence;
    }
  }

  return evidence.slice(0, MAX_FINDING_EVIDENCE);
}

function toRegressionImprovementProposal(finding: RegressionFindingRecord): ImprovementProposalRecord {
  const riskLevel = finding.category === "failed-hand-run" ? "high" : "medium";
  const verificationPlan = buildRegressionProposalVerificationPlan(finding);

  return {
    ...buildImprovementCandidateRecord(
      {
        candidateKey: finding.candidateKey,
        summary: buildRegressionProposalSummary(finding),
        problemStatement: finding.summary,
        proposedAction: buildRegressionProposalAction(finding),
        expectedBenefit: buildRegressionProposalBenefit(finding),
        riskLevel,
        verificationPlan,
        derivedFromSignalKeys: [finding.findingKey],
        evidence: finding.evidence,
        risk: {
          level: riskLevel,
          summary:
            finding.category === "failed-hand-run"
              ? "Failed scheduled hands can silently erode the bounded self-improvement loop if operators are not alerted."
              : "Repeated fallback or blocked-tool behavior can normalize degraded operation unless an operator inspects the evidence."
        },
        verification: {
          status: "pending",
          summary: verificationPlan
        }
      },
      new Date(0).toISOString()
    ),
    proposalKey: `${finding.sourceReflectionSessionId}@${finding.sourceLastTx}:${finding.candidateKey}`,
    sourceReflectionSessionId: finding.sourceReflectionSessionId,
    sourceSessionId: finding.sourceSessionId,
    sourceLastTx: finding.sourceLastTx
  };
}

function buildRegressionProposalSummary(finding: RegressionFindingRecord): string {
  if (finding.category === "fallback-spike") {
    return "Investigate the recent fallback spike before it becomes the steady-state assistant path.";
  }

  if (finding.category === "blocked-tool-spike") {
    return "Investigate the recent blocked-tool spike and confirm the gating or capability posture is still intentional.";
  }

  return "Stabilize the failing scheduled hand path before more bounded automation runs degrade.";
}

function buildRegressionProposalAction(finding: RegressionFindingRecord): string {
  if (finding.category === "fallback-spike") {
    return "Review the recent fallback evidence, confirm the preferred route still has valid prerequisites, and reduce avoidable fallback use without removing deterministic fallback continuity.";
  }

  if (finding.category === "blocked-tool-spike") {
    return "Inspect the recent blocked or failed tool-audit evidence, then either restore the intended capability path or make the degraded posture explicit in operator guidance.";
  }

  return "Inspect the most recent failed hand-run evidence, repair the failing hand/runtime seam, and confirm future scheduled runs remain bounded and observable.";
}

function buildRegressionProposalBenefit(finding: RegressionFindingRecord): string {
  if (finding.category === "fallback-spike") {
    return "Restores confidence that the preferred assistant path is healthy while preserving the safe fallback path as a backstop instead of the norm.";
  }

  if (finding.category === "blocked-tool-spike") {
    return "Makes repeated blocked-tool behavior visible before it silently reduces skill usefulness or operator trust.";
  }

  return "Keeps the bundled hand runtime reliable enough for bounded self-improvement work without introducing autonomous rollback or deploy blocking.";
}

function buildRegressionProposalVerificationPlan(finding: RegressionFindingRecord): string {
  if (finding.category === "failed-hand-run") {
    return "Verify a later regression-watch run sees no fresh failed hand runs for the same seam and that existing chat, hands, and Telegram behavior remain stable when the watch is idle.";
  }

  return "Verify a later regression-watch run drops below the configured threshold while existing chat, hands, and Telegram behavior remain stable when the watch is idle.";
}

function buildBundledHandState(
  definition: BundledHandDefinition,
  toolEvents: ToolEvent[]
): BundledHandState {
  const lifecycleEvents = toolEvents.filter(
    (event) =>
      event.toolName === HAND_LIFECYCLE_TOOL &&
      (event.metadata?.action === "activate" || event.metadata?.action === "pause")
  );
  const latestLifecycle = lifecycleEvents[lifecycleEvents.length - 1] ?? null;
  const recentRuns = toolEvents
    .filter((event) => event.toolName === HAND_RUN_TOOL)
    .slice()
    .reverse()
    .map((event) => toHandRunRecord(event))
    .slice(0, MAX_RUN_HISTORY);
  const recentAudit = toolEvents
    .slice()
    .reverse()
    .map((event) => toHandAuditRecord(event))
    .filter((event): event is HandAuditRecord => event !== null)
    .slice(0, MAX_AUDIT_HISTORY);
  const latestRun = recentRuns[0] ?? null;

  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    implementation: definition.implementation,
    runtime: definition.runtime,
    scheduleCrons: [...definition.scheduleCrons],
    status: latestLifecycle?.metadata?.action === "activate" ? "active" : "paused",
    persisted: toolEvents.length > 0,
    updatedAt: latestLifecycle?.createdAt ?? null,
    lastLifecycleAction: toHandLifecycleAction(latestLifecycle?.metadata),
    latestRun,
    recentRuns,
    recentAudit
  };
}

function toHandLifecycleAction(metadata: JsonObject | null | undefined): HandLifecycleAction | null {
  return metadata?.action === "activate" || metadata?.action === "pause" ? metadata.action : null;
}

function toHandAuditRecord(event: ToolEvent): HandAuditRecord | null {
  const audit = asJsonObject(event.metadata?.audit);

  if (!audit) {
    return null;
  }

  return {
    timestamp: event.createdAt,
    toolName: event.toolName,
    action: typeof event.metadata?.action === "string" ? event.metadata.action : null,
    summary: event.summary,
    outcome: toAuditOutcome(audit.outcome),
    policy: typeof audit.policy === "string" ? audit.policy : null,
    capability: typeof audit.capability === "string" ? audit.capability : null,
    actor: typeof audit.actor === "string" ? audit.actor : null,
    detail: typeof audit.detail === "string" ? audit.detail : null,
    cron: typeof event.metadata?.cron === "string" ? event.metadata.cron : null,
    maintenanceSessionId:
      typeof event.metadata?.maintenanceSessionId === "string"
        ? event.metadata.maintenanceSessionId
        : null
  };
}

function toHandRunRecord(event: ToolEvent): HandRunRecord {
  return {
    timestamp: event.createdAt,
    status: event.metadata?.status === "failed" ? "failed" : "succeeded",
    cron: typeof event.metadata?.cron === "string" ? event.metadata.cron : null,
    summary: event.summary,
    maintenanceSessionId:
      typeof event.metadata?.maintenanceSessionId === "string"
        ? event.metadata.maintenanceSessionId
        : null,
    proposalSessionId:
      typeof event.metadata?.proposalSessionId === "string" ? event.metadata.proposalSessionId : null,
    reviewedSessionCount:
      typeof event.metadata?.reviewedSessionCount === "number" ? event.metadata.reviewedSessionCount : 0,
    reflectedSessionCount:
      typeof event.metadata?.reflectedSessionCount === "number"
        ? event.metadata.reflectedSessionCount
        : 0,
    reviewedSignalCount:
      typeof event.metadata?.reviewedSignalCount === "number" ? event.metadata.reviewedSignalCount : 0,
    reviewedReflectionCount:
      typeof event.metadata?.reviewedReflectionCount === "number" ? event.metadata.reviewedReflectionCount : 0,
    correctionSignalCount:
      typeof event.metadata?.correctionSignalCount === "number"
        ? event.metadata.correctionSignalCount
        : 0,
    matchedCorrectionCount:
      typeof event.metadata?.matchedCorrectionCount === "number"
        ? event.metadata.matchedCorrectionCount
        : 0,
    generatedProposalCount:
      typeof event.metadata?.generatedProposalCount === "number" ? event.metadata.generatedProposalCount : 0,
    evaluatedProposalCount:
      typeof event.metadata?.evaluatedProposalCount === "number" ? event.metadata.evaluatedProposalCount : 0,
    awaitingApprovalCount:
      typeof event.metadata?.awaitingApprovalCount === "number" ? event.metadata.awaitingApprovalCount : 0,
    skippedDuplicateProposalCount:
      typeof event.metadata?.skippedDuplicateProposalCount === "number"
        ? event.metadata.skippedDuplicateProposalCount
        : 0,
    reviewedDocumentCount:
      typeof event.metadata?.reviewedDocumentCount === "number" ? event.metadata.reviewedDocumentCount : 0,
    reviewedClaimCount:
      typeof event.metadata?.reviewedClaimCount === "number" ? event.metadata.reviewedClaimCount : 0,
    findingCount: typeof event.metadata?.findingCount === "number" ? event.metadata.findingCount : 0,
    findings: toHandFindingRecords(event.metadata?.findings),
    signalSessionId:
      typeof event.metadata?.signalSessionId === "string" ? event.metadata.signalSessionId : null,
    healthyCount: typeof event.metadata?.healthyCount === "number" ? event.metadata.healthyCount : 0,
    degradedCount: typeof event.metadata?.degradedCount === "number" ? event.metadata.degradedCount : 0,
    unavailableCount:
      typeof event.metadata?.unavailableCount === "number" ? event.metadata.unavailableCount : 0,
    unknownCount: typeof event.metadata?.unknownCount === "number" ? event.metadata.unknownCount : 0,
    providerHealthFindings: toProviderHealthFindings(event.metadata?.providerHealthFindings),
    error: typeof event.metadata?.error === "string" ? event.metadata.error : null
  };
}

function toAuditOutcome(value: unknown): HandAuditRecord["outcome"] {
  return value === "succeeded" || value === "blocked" || value === "failed" ? value : null;
}

function asJsonObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function toHandFindingRecords(value: unknown): HandFindingRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => asJsonObject(entry))
    .filter(
      (entry): entry is HandFindingRecord =>
        entry !== null && typeof entry.findingKey === "string" && typeof entry.summary === "string"
    );
}

function toProviderHealthFindings(value: unknown): ProviderHealthFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => asJsonObject(entry))
    .filter(
      (entry): entry is ProviderHealthFinding =>
        entry !== null &&
        typeof entry.findingKey === "string" &&
        typeof entry.surface === "string" &&
        typeof entry.status === "string" &&
        typeof entry.summary === "string"
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

function buildMetricEvidence(summary: string): ImprovementEvidenceRecord {
  return {
    kind: "metric",
    summary,
    eventId: null,
    tx: null,
    excerpt: null
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

async function runGithubCoordinator(env: Pick<Env, "GEMINI_API_KEY" | "AARONDB">): Promise<JsonObject> {
  // Mock implementation for Phase 1 Scaffolding
  return {
    action: "coordinated",
    timestamp: new Date().toISOString(),
    status: "awaiting-operator-signal"
  };
}

function trimText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

async function runTtlGarbageCollector(env: Pick<Env, "AARONDB">): Promise<JsonObject> {
  const ttlDays = 30;
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();

  const result = await env.AARONDB.prepare(
    "DELETE FROM aarondb_facts WHERE occurred_at < ?"
  ).bind(cutoff).run();

  return {
    ttlDays,
    cutoff,
    deletedCount: result.meta.changes,
    success: true
  };
}

async function runOrphanFactCleanup(env: Pick<Env, "AARONDB">): Promise<JsonObject> {
  const result = await env.AARONDB.prepare(
    "SELECT DISTINCT session_id FROM aarondb_facts WHERE session_id LIKE 'reflection:%'"
  ).all<{ session_id: string }>();

  let deletedCount = 0;
  const orphans = [];

  for (const row of result.results ?? []) {
    const sourceSessionId = row.session_id.replace("reflection:", "");
    const sourceExists = await env.AARONDB.prepare(
      "SELECT 1 FROM aarondb_facts WHERE session_id = ? LIMIT 1"
    ).bind(sourceSessionId).first();

    if (!sourceExists) {
      const delResult = await env.AARONDB.prepare(
        "DELETE FROM aarondb_facts WHERE session_id = ?"
      ).bind(row.session_id).run();
      deletedCount += delResult.meta.changes;
      orphans.push(row.session_id);
    }
  }

  return {
    deletedCount,
    orphanedReflectionCount: orphans.length,
    orphans,
    success: true
  };
}

async function runDailyBriefingGenerator(env: Pick<Env, "AARONDB">): Promise<JsonObject> {
  const result = await runScheduledMaintenance({
    env,
    cron: scheduledMaintenanceCrons.morningBriefing
  });

  return {
    ...result,
    success: true
  };
}