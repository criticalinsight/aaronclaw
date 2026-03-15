import {
  buildImprovementCandidateRecord,
  IMPROVEMENT_PROPOSAL_SESSION_ID,
  listRecentStoredReflectionArtifacts,
  readImprovementProposalState,
  type ImprovementEvidenceRecord,
  type ImprovementProposalRecord,
  runScheduledImprovementProposalReview,
  runScheduledImprovementShadowEvaluation,
  runScheduledUserCorrectionMining,
  runScheduledMaintenance,
  runReflexiveAudit,
  runAutonomousEvolution,
  runSyntheticReflectionLoop,
  runTelemetricAudit,
  scheduledMaintenanceCrons,
  type ReflexiveAuditResult
} from "./reflection-engine";
import { runScheduledDocsDriftReview, type DocsDriftFinding } from "./docs-drift";
import { initiateSelfHealing } from "./aeturnus-engine";
import { rebalanceInfrastructure } from "./sovereign-engine";
import { runProviderHealthWatchdog, type ProviderHealthFinding } from "./provider-health-watchdog";
import { mountAaronDbEdgeSessionRuntime } from "./aarondb-edge-substrate";
import { type AssistantProviderRoute, generateAssistantReply } from "./assistant";
import { AaronDbEdgeSessionRepository, type JsonObject, type ToolEvent, type SessionRecord } from "./session-state";
import { buildToolAuditRecord } from "./tool-policy";
import { KnowledgeHub } from "./knowledge-hub";
import { queryKnowledgeVault } from "./knowledge-vault";

import { bundledHandDefinitions, type BundledHandDefinition } from "./hands-catalog";
import { runGithubCoordinator as githubCoordinatorImpl } from "./github-coordinator";
import { generateDocsSiteContent } from "./docs-generator";
import { createGithubRepository, pushFilesToGithub, createPullRequest } from "./github-coordinator";
import { createCloudflareWorker, putCloudflareSecret, deploySimpleSite } from "./wrangler-orchestration";
import { readProviderKeyFromEnv } from "./provider-key-store";
import { generateWebsiteContent } from "./website-generator";
import { runKnowledgeBroadcaster, runKnowledgeSubscriber } from "./nexus-engine";

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
  promotedProposalCount: number;
  spawnedAgentCount: number;
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

export async function triggerBundledHandRunManual(input: {
  env: Env;
  handId: string;
  input?: any;
}): Promise<BundledHandState | null> {
  const definition = getBundledHandDefinition(input.handId);

  if (!definition) {
    return null;
  }

  const timestamp = new Date().toISOString();
  await executeBundledHandRun({
    env: input.env,
    definition,
    cron: "manual",
    timestamp,
    input: input.input
  });

  return readBundledHandState({ env: input.env, handId: definition.id });
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
  env: Env;
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
  env: Pick<Env, "AARONDB" | "DB">,
  definition: BundledHandDefinition,
  timestamp: string
): Promise<AaronDbEdgeSessionRepository> {
  const dbs: D1Database[] = [env.AARONDB];
  if (env.DB) dbs.push(env.DB);
  const repository = new AaronDbEdgeSessionRepository(dbs, buildHandSessionId(definition.id));
  await repository.createSession(timestamp);
  return repository;
}

async function executeBundledHandRun(input: {
  env: Env;
  definition: BundledHandDefinition;
  cron: string;
  timestamp: string;
  input?: any;
}): Promise<void> {
  const sandboxedEnv = mountSubstrateSandbox(input.env, input.definition.id);
  const repository = await ensureHandRepository(sandboxedEnv, input.definition, input.timestamp);

  try {
    if (input.definition.implementation === "scheduled-maintenance") {
      await runTelemetricAudit({
        env: sandboxedEnv,
        cron: input.cron,
        timestamp: input.timestamp
      });
      const maintenance = await runScheduledMaintenance({
        env: sandboxedEnv,
        cron: input.cron,
        timestamp: input.timestamp
      });

      // 🧙🏾‍♂️ Autonomous Self-Healing (Aeturnus)
      const healing = await initiateSelfHealing(sandboxedEnv);

      // 🧙🏾‍♂️ Infrastructure Rebalancing (Sovereign)
      const rebalance = await rebalanceInfrastructure(sandboxedEnv, new Map());

      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} ran for cron ${input.cron}. Reviewed ${maintenance.reviewedSessionIds.length} sessions, reflected ${maintenance.reflectedSessionIds.length} insights. Healing: ${healing.recoveredNodes.length} nodes recovered. Infrastructure: ${rebalance.status}.`,
        metadata: {
          action: "run",
          cron: input.cron,
          handId: input.definition.id,
          maintenanceSessionId: maintenance.maintenanceSessionId,
          reflectedSessionCount: maintenance.reflectedSessionIds.length,
          reviewedSessionCount: maintenance.reviewedSessionIds.length,
          recoveredNodeCount: healing.recoveredNodes.length,
          infrastructureStatus: rebalance.status,
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
              reviewedSessionCount: maintenance.reviewedSessionIds.length,
              recoveredNodes: healing.recoveredNodes,
              rebalanceStatus: rebalance.status
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
      const reflexiveAudit = await runReflexiveAudit({
        env: input.env,
        cron: input.cron,
        timestamp: input.timestamp
      });

      // Recursive Evolution: Spawn improved agents from "Promoted" proposals
      const recursiveEvolution = await triggerRecursiveEvolution({
        env: sandboxedEnv,
        timestamp: input.timestamp
      });

      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} reviewed ${proposalReview.reviewedSignalCount} signals, wrote ${proposalReview.generatedProposalCount + reflexiveAudit.generatedProposalCount} proposals, evaluated ${shadowEvaluation.evaluatedProposalCount} candidates, and spawned ${recursiveEvolution.spawnedAgentCount} improved agent(s) for cron ${input.cron}.`,
        metadata: {
          action: "run",
          awaitingApprovalCount: shadowEvaluation.awaitingApprovalCount,
          cron: input.cron,
          evaluatedProposalCount: shadowEvaluation.evaluatedProposalCount,
          generatedProposalCount: proposalReview.generatedProposalCount + reflexiveAudit.generatedProposalCount,
          handId: input.definition.id,
          proposalSessionId: proposalReview.proposalSessionId,
          reviewedReflectionCount: proposalReview.reviewedReflectionSessionIds.length,
          reviewedSignalCount: proposalReview.reviewedSignalCount,
          skippedDuplicateProposalCount: proposalReview.skippedDuplicateProposalCount,
          promotedProposalCount: recursiveEvolution.promotedCount,
          spawnedAgentCount: recursiveEvolution.spawnedAgentCount,
          latencyAnomalies: reflexiveAudit.latencyAnomalies,
          errorClusters: reflexiveAudit.errorClusters,
          status: "succeeded",
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} completed successfully with recursive evolution.`,
            extra: {
              cron: input.cron,
              spawnedAgentCount: recursiveEvolution.spawnedAgentCount,
              latencyAnomalies: reflexiveAudit.latencyAnomalies,
              errorClusters: reflexiveAudit.errorClusters
            }
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "user-correction-miner") {
      const correctionReview = await runScheduledUserCorrectionMining({
        env: sandboxedEnv,
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
        env: sandboxedEnv,
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
          findingCount: regressionReview.findingCount,
          findings: regressionReview.findings,
          generatedProposalCount: regressionReview.generatedProposalCount,
          handId: input.definition.id,
          proposalSessionId: regressionReview.proposalSessionId,
          reviewedReflectionCount: regressionReview.reviewedReflectionCount,
          reviewedSignalCount: regressionReview.reviewedSignalCount,
          skippedDuplicateProposalCount: regressionReview.skippedDuplicateProposalCount,
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
              findingCount: regressionReview.findingCount,
              generatedProposalCount: regressionReview.generatedProposalCount,
              proposalSessionId: regressionReview.proposalSessionId,
              reviewedReflectionCount: regressionReview.reviewedReflectionCount,
              reviewedSignalCount: regressionReview.reviewedSignalCount,
              skippedDuplicateProposalCount: regressionReview.skippedDuplicateProposalCount
            }
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "docs-drift") {
      const docsDriftReview = await runScheduledDocsDriftReview({
        env: sandboxedEnv,
        cron: input.cron
      });

      let factorySummary = "";
      if (docsDriftReview.findingCount > 0) {
        // 🧙🏾‍♂️ Rich Hickey: Documentation must derive from the truth.
        // If drift is detected, synthesize the new truth.
        const factoryResult = await runDocsFactory({
          env: sandboxedEnv,
          cron: input.cron,
          timestamp: input.timestamp
        });
        factorySummary = ` Autonomous refresh triggered: ${factoryResult.summary}`;
      }

      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: docsDriftReview.summary + factorySummary,
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
            detail: docsDriftReview.summary + factorySummary,
            extra: {
              cron: input.cron,
              findingCount: docsDriftReview.findingCount,
              reviewedClaimCount: docsDriftReview.reviewedClaimCount,
              reviewedDocumentCount: docsDriftReview.reviewedDocumentCount,
              factorySummary
            }
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "provider-health-watchdog") {
      const healthReport = await runProviderHealthWatchdog({
        env: sandboxedEnv,
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

    if (input.definition.implementation === "nexus-broadcaster-hand") {
      const result = await runKnowledgeBroadcaster(sandboxedEnv, input.timestamp);
      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} distilled ${result.distilledCount} universal pattern(s) and skipped ${result.skippedCount} duplicates.`,
        metadata: {
          action: "run",
          cron: input.cron,
          handId: input.definition.id,
          distilledCount: result.distilledCount,
          skippedCount: result.skippedCount,
          status: "succeeded",
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} distilled ${result.distilledCount} pattern(s).`,
            extra: {
              cron: input.cron,
              distilledCount: result.distilledCount,
              skippedCount: result.skippedCount
            }
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "nexus-subscriber-hand") {
      const result = await runKnowledgeSubscriber(sandboxedEnv, input.timestamp);
      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} ingested ${result.ingestedCount} global pattern(s) and asserted ${result.signalsAsserted} local synthesis signal(s).`,
        metadata: {
          action: "run",
          cron: input.cron,
          handId: input.definition.id,
          ingestedCount: result.ingestedCount,
          signalsAsserted: result.signalsAsserted,
          status: "succeeded",
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} ingested ${result.ingestedCount} pattern(s).`,
            extra: {
              cron: input.cron,
              ingestedCount: result.ingestedCount,
              signalsAsserted: result.signalsAsserted
            }
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "ttl-garbage-collector") {
      const report = await runTtlGarbageCollector(sandboxedEnv);
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
      const report = await runOrphanFactCleanup(sandboxedEnv);
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

    if (input.definition.implementation === "github-coordinator") {
      const result = await runGithubCoordinator(sandboxedEnv);
      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} coordinated development lifecycle.`,
        metadata: {
          action: "coordinated",
          handId: input.definition.id,
          status: "succeeded",
          result,
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} coordinated successfully.`
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "docs-factory") {
      const result = await runDocsFactory({
        env: sandboxedEnv,
        cron: input.cron,
        timestamp: input.timestamp
      });
      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: result.summary,
        metadata: {
          action: "run",
          cron: input.cron,
          handId: input.definition.id,
          status: result.success ? "succeeded" : "failed",
          error: result.error ?? null,
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: result.success ? "succeeded" : "failed",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: result.summary
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "daily-briefing-generator") {
      const briefing = await runDailyBriefingGenerator(sandboxedEnv);
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

    if (input.definition.implementation === "structural-hand-synthesis") {
      const evolution = await runAutonomousEvolution({
        env: sandboxedEnv,
        cron: input.cron,
        timestamp: input.timestamp
      });

      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} processed successful trajectories. PROMOTE: ${evolution.promotedCount}, DISTILL: ${evolution.distilledCount}.`,
        metadata: {
          action: "run",
          cron: input.cron,
          handId: input.definition.id,
          promotedCount: evolution.promotedCount,
          distilledCount: evolution.distilledCount,
          status: "succeeded",
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} completed with ${evolution.promotedCount} promotions and ${evolution.distilledCount} distillations.`
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "managed-refactor") {
      const refactorResult = await runManagedRefactorHand({
        env: input.env,
        timestamp: input.timestamp
      });

      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} processed ${refactorResult.processedCount} improvement(s). ${refactorResult.succeededCount} PR(s) submitted, ${refactorResult.errorCount} error(s).`,
        metadata: {
          action: "run",
          cron: input.cron,
          handId: input.definition.id,
          processedCount: refactorResult.processedCount,
          succeededCount: refactorResult.succeededCount,
          errorCount: refactorResult.errorCount,
          status: refactorResult.errorCount > 0 ? "failed" : "succeeded",
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: refactorResult.errorCount > 0 ? "failed" : "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} processed ${refactorResult.processedCount} improvements with ${refactorResult.succeededCount} successes.`,
            extra: {
              ...refactorResult
            }
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "synthetic-reflection-loop") {
      const result = await runSyntheticReflectionLoop({
        env: sandboxedEnv,
        timestamp: input.timestamp
      });

      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} created ${result.generatedPatternCount} global chaos pattern(s). Scenarios: ${result.syntheticScenarios.join(", ")}.`,
        metadata: {
          action: "run",
          cron: input.cron,
          handId: input.definition.id,
          generatedPatternCount: result.generatedPatternCount,
          status: "succeeded",
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} synthesized ${result.generatedPatternCount} chaos scenarios.`
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "website-factory") {
      const isScheduled = !input.input?.prompt;
      
      if (isScheduled) {
        // 🧙🏾‍♂️ Rich Hickey: Scheduled run for a factory is a health check.
        await repository.appendToolEvent({
          timestamp: input.timestamp,
          toolName: HAND_RUN_TOOL,
          summary: `${input.definition.label} autonomous check: factory ready for synthesis. No manual prompt received; skipping deployment.`,
          metadata: {
            action: "run",
            cron: input.cron,
            handId: input.definition.id,
            status: "succeeded",
            audit: buildToolAuditRecord({
              toolId: "hand-run",
              actor: "hand-runtime",
              scope: "hand",
              outcome: "succeeded",
              timestamp: input.timestamp,
              handId: input.definition.id,
              detail: `${input.definition.label} autonomous health check passed.`
            })
          }
        });
        return;
      }

      await runWebsiteFactory(input.env, { 
        input: { 
            prompt: "A minimalist premium website", // Default
            ...input.input
        },
        sessionId: input.input?.sessionId
      });
      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} processed website generation request.`,
        metadata: {
          action: "run",
          cron: input.cron,
          handId: input.definition.id,
          status: "succeeded",
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} completed website synthesis.`
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "mesh-coordinator-hand") {
      const coordinatorResult = await runMeshCoordinatorHand({
        env: sandboxedEnv,
        cron: input.cron,
        timestamp: input.timestamp
      });

      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} evaluated mesh health and asserted ${coordinatorResult.assertedSignalCount} coordination signal(s). Status: ${coordinatorResult.status}.`,
        metadata: {
          action: "run",
          cron: input.cron,
          handId: input.definition.id,
          assertedSignalCount: coordinatorResult.assertedSignalCount,
          status: "succeeded",
          coordinatorResult,
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} successfully coordinated hand mesh with ${coordinatorResult.assertedSignalCount} signals.`
          })
        }
      });
      return;
    }

    if (input.definition.implementation === "substrate-integrity-warden") {
      const auditResult = await runSubstrateIntegrityWarden({
        env: sandboxedEnv,
        cron: input.cron,
        timestamp: input.timestamp
      });

      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: HAND_RUN_TOOL,
        summary: `${input.definition.label} completed substrate audit. Defects: ${auditResult.defectCount}, Corrections: ${auditResult.correctionCount}.`,
        metadata: {
          action: "run",
          cron: input.cron,
          handId: input.definition.id,
          defectCount: auditResult.defectCount,
          correctionCount: auditResult.correctionCount,
          status: "succeeded",
          auditResult,
          audit: buildToolAuditRecord({
            toolId: "hand-run",
            actor: "hand-runtime",
            scope: "hand",
            outcome: "succeeded",
            timestamp: input.timestamp,
            handId: input.definition.id,
            detail: `${input.definition.label} found ${auditResult.defectCount} defects and applied ${auditResult.correctionCount} corrections.`
          })
        }
      });
      return;
    }

    // Generic fallback for Phase 2 Scaffolding (handles all other 39 implementations)
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
    promotedProposalCount:
      typeof event.metadata?.promotedProposalCount === "number" ? event.metadata.promotedProposalCount : 0,
    spawnedAgentCount:
      typeof event.metadata?.spawnedAgentCount === "number" ? event.metadata.spawnedAgentCount : 0,
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

async function runGithubCoordinator(env: Pick<Env, "GEMINI_API_KEY" | "AARONDB" | "GITHUB_TOKEN">): Promise<JsonObject> {
  return githubCoordinatorImpl(env);
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
async function runDocsFactory(input: {
  env: Pick<
    Env,
    | "AARONDB"
    | "GEMINI_API_KEY"
    | "GITHUB_TOKEN"
    | "CLOUDFLARE_API_TOKEN"
    | "CLOUDFLARE_EMAIL"
    | "CLOUDFLARE_API_KEY"
    | "CLOUDFLARE_ACCOUNT_ID"
  >;
  cron: string | null;
  timestamp: string;
}): Promise<{ success: boolean; summary: string; error?: string }> {
  try {
    const githubToken = readProviderKeyFromEnv(input.env, "github");
    let githubPushStatus = "skipped (no token)";

    // 1. Generate Schematic Content
    const changes = await generateDocsSiteContent();

    // 2. Synthesize a minimalist Docs Serving Worker
    // 🧙🏾‍♂️ Rich Hickey: Simplify transport. A single worker serving a content map.
    const fileMap = JSON.stringify(Object.fromEntries(changes.map(c => [c.path, c.content])));
    const workerScript = `
      const FILES = ${fileMap};
      addEventListener('fetch', event => {
        event.respondWith(handleRequest(event.request));
      });
      async function handleRequest(request) {
        const url = new URL(request.url);
        let path = url.pathname.slice(1) || 'index.html';
        const content = FILES[path];
        if (!content) return new Response('Not Found', { status: 404 });
        const type = path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/plain';
        return new Response(content, { headers: { 'content-type': type } });
      }
    `;

    // 3. Push to GitHub (Optional)
    // 🧙🏾‍♂️ Rich Hickey: Identity is sacred. The docs belong at 'docs'.
    const repoName = "docs";
    if (githubToken) {
      try {
        try {
          await createGithubRepository(githubToken, {
            owner: "criticalinsight",
            repo: repoName,
            description: "Schematic-styled documentation for AaronClaw. Autogenerated.",
            private: false
          });
        } catch (e) {
          // Ignore if repo already exists
        }

        await pushFilesToGithub(githubToken, "criticalinsight", repoName, "main", [
          ...changes,
          { path: "worker.js", content: workerScript }
        ], "Docs Factory: update truth");
        githubPushStatus = "pushed";
      } catch (error) {
        console.warn("Docs Factory: GitHub push failed, proceeding to Cloudflare:", error);
        githubPushStatus = `failed (${error instanceof Error ? error.message : String(error)})`;
      }
    } else {
      console.log("Docs Factory: skipping GitHub push (AARONCLAW_GITHUB_TOKEN not configured).");
    }

    // 4. Deploy to Cloudflare
    const cfToken = input.env.CLOUDFLARE_API_TOKEN;
    const cfEmail = input.env.CLOUDFLARE_EMAIL;
    const cfKey = input.env.CLOUDFLARE_API_KEY;
    const cfAccountId = input.env.CLOUDFLARE_ACCOUNT_ID;

    let cfDeployStatus = "skipped (missing credentials)";
    if (cfAccountId && (cfToken || (cfEmail && cfKey))) {
      await createCloudflareWorker(
        { token: cfToken, email: cfEmail, key: cfKey },
        cfAccountId,
        {
          name: repoName,
          main: "worker.js",
          compatibility_date: "2026-03-13"
        },
        workerScript
      );
      cfDeployStatus = "deployed";
    }

    return {
      success: true,
      summary: `Docs Factory completed: GitHub (${githubPushStatus}), Cloudflare (${cfDeployStatus}). Generated ${changes.length} file(s).`
    };
  } catch (error) {
    console.error("Docs Factory failed:", error);
    return {
      success: false,
      summary: `Docs Factory failed: ${error instanceof Error ? error.message : String(error)}`,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * 🧙🏾‍♂️ Rich Hickey: Decoupling intent (prompt) from realization (worker).
 */
async function runWebsiteFactory(
  env: Pick<
    Env,
    | "AI"
    | "AI_MODEL"
    | "GEMINI_API_KEY"
    | "CLOUDFLARE_API_TOKEN"
    | "CLOUDFLARE_EMAIL"
    | "CLOUDFLARE_API_KEY"
    | "CLOUDFLARE_ACCOUNT_ID"
    | "AARONDB"
  >,
  options: { input?: { prompt?: string; name?: string }; sessionId?: string; onProgress?: (ev: any) => void } = {}
): Promise<void> {
  const prompt = options.input?.prompt;
  if (typeof prompt !== "string") {
    throw new Error("website-factory requires a prompt string in options.input.prompt");
  }

  const name = options.input?.name || `site-${Math.random().toString(36).slice(2, 8)}`;
  
  console.log(`Starting Website Factory for prompt: "${prompt}" (Target name: ${name})`);

  // 1. Synthesize content
  const files = await generateWebsiteContent(env, prompt, options.sessionId);
  
  // 2. Map files to format expected by deploySimpleSite
  const sitesFiles = files.map(f => ({ path: f.path, content: f.content }));

  // 3. Deploy
  const credentials = {
    token: env.CLOUDFLARE_API_TOKEN,
    email: env.CLOUDFLARE_EMAIL,
    key: env.CLOUDFLARE_API_KEY
  };
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;

  if (!accountId) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is required for website-factory deployment.");
  }

  const deployment = await deploySimpleSite(credentials, accountId, name, sitesFiles);
  
  console.log(`Website Factory deployment complete: ${deployment.url || `https://${name}.workers.dev`}`);
  
  // Tag the run (optional as handled by appendToolEvent in executeBundledHandRun)
}

async function triggerRecursiveEvolution(input: {
  env: Pick<Env, "AARONDB" | "DB" | "APP_AUTH_TOKEN">;
  timestamp: string;
}): Promise<{ promotedCount: number; spawnedAgentCount: number }> {
  // Query for "promoted" proposals that haven't been acted upon yet
  // For now, we look at the proposal session directly
  const dbs: D1Database[] = [input.env.AARONDB];
  if (input.env.DB) dbs.push(input.env.DB);
  const repository = new AaronDbEdgeSessionRepository(dbs, IMPROVEMENT_PROPOSAL_SESSION_ID);
  const session = await repository.getSession();
  const events = session?.toolEvents ?? [];

  const promotedProposals: ImprovementProposalRecord[] = [];
  const spawnedAgentKeys = new Set<string>();

  for (const event of events) {
    if (event.toolName === "improvement-candidate-review" && event.metadata?.proposals) {
      const records = event.metadata.proposals as ImprovementProposalRecord[];
      for (const p of records) {
        if (p.status === "promoted") {
          promotedProposals.push(p);
        }
      }
    }
    if (event.toolName === "hand-run" && event.metadata?.spawnedAgentKeys) {
       (event.metadata.spawnedAgentKeys as string[]).forEach(k => spawnedAgentKeys.add(k));
    }
  }

  const pendingSpawn = promotedProposals.filter(p => !spawnedAgentKeys.has(p.candidateKey));
  let spawnedCount = 0;

  const hub = new KnowledgeHub(dbs);
  const globalPatterns = await hub.queryKnowledge();

  for (const proposal of pendingSpawn) {
    // 🧙🏾‍♂️ Rich Hickey: Evolution is the process of specializing from general truth.
    // We spawn an agent with the learned bootstrap extension, augmented by the Knowledge Hub.
    const relevantPatterns = globalPatterns
      .filter(p => p.category === proposal.category)
      .slice(0, 3);
    try {
      const spawnUrl = `https://aaronclaw.moneyacad.workers.dev/api/spawn`;
      const response = await fetch(spawnUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${input.env.APP_AUTH_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: `evolved-${proposal.candidateKey}`,
          description: proposal.summary,
          bootstrapExtension: {
             sourceProposalKey: proposal.proposalKey,
             proposedAction: proposal.proposedAction,
             pattern: proposal.problemStatement,
             globalPatterns: relevantPatterns.map(p => ({
               key: p.patternKey,
               action: p.proposedAction,
               benefit: p.expectedBenefit
             }))
          }
        })
      });

      if (response.ok) {
        spawnedCount += 1;
        // Mark as spawned in the hand session (via return value and repository update)
      }
    } catch (e) {
      console.error(`Recursive Evolution: Failed to spawn agent for ${proposal.candidateKey}`, e);
    }
  }

  if (spawnedCount > 0) {
      await repository.appendToolEvent({
        timestamp: input.timestamp,
        toolName: "hand-run",
        summary: `Recursive Evolution spawned ${spawnedCount} improved agent(s).`,
        metadata: {
           spawnedAgentKeys: pendingSpawn.map(p => p.candidateKey).slice(0, spawnedCount)
        }
      });
  }

  return {
    promotedCount: promotedProposals.length,
    spawnedAgentCount: spawnedCount
  };
}

async function runManagedRefactorHand(input: {
  env: Pick<Env, "AARONDB" | "AI" | "GITHUB_TOKEN" | "DB">;
  timestamp: string;
}): Promise<{ processedCount: number; succeededCount: number; errorCount: number }> {
  const dbs: D1Database[] = [input.env.AARONDB];
  if (input.env.DB) dbs.push(input.env.DB);
  
  const proposalRepository = new AaronDbEdgeSessionRepository(dbs, IMPROVEMENT_PROPOSAL_SESSION_ID);
  const session = await proposalRepository.getSession();
  const events = session?.toolEvents ?? [];

  const candidates: ImprovementProposalRecord[] = [];
  for (const event of events) {
    if (event.toolName === "improvement-proposal-review" && event.metadata?.proposals) {
      const records = event.metadata.proposals as ImprovementProposalRecord[];
      for (const p of records) {
        if (p.status === "promoted" && p.category === "external-optimization" && !p.promotion?.liveMutationApplied) {
          candidates.push(p);
        }
      }
    }
  }

  let succeededCount = 0;
  let errorCount = 0;

  for (const proposal of candidates) {
    try {
      // 1. Resolve managed project configuration
      const projectAttrs = await input.env.AARONDB.prepare(
        "SELECT entity, value_json FROM aarondb_facts WHERE attribute = 'managed/project' AND entity LIKE ?"
      ).bind(`${proposal.sourceSessionId}%`).first<{ entity: string; value_json: string }>();

      if (!projectAttrs) {
        console.warn(`Managed Refactor: No project found for proposal ${proposal.candidateKey}`);
        continue;
      }

      const config = JSON.parse(projectAttrs.value_json);
      const [owner, repo] = config.repoUrl.replace("https://github.com/", "").split("/");

      // 2. Synthesize code refactor
      const dummySession: SessionRecord = {
        id: `refactor:${proposal.candidateKey}`,
        createdAt: input.timestamp,
        lastActiveAt: input.timestamp,
        lastTx: 0,
        persistence: "aarondb-edge",
        memorySource: "aarondb-edge",
        events: [],
        messages: [],
        toolEvents: [],
        recallableMemoryCount: 0
      };

      const refactorReply = await generateAssistantReply({
        env: input.env as any,
        session: dummySession,
        sessionId: dummySession.id,
        userMessage: `🧙🏾‍♂️ Architectura has identified a structural improvement for ${config.repoUrl}.
Rationale: ${proposal.rationale}
Problem: ${proposal.problemStatement}
Target: ${proposal.proposedAction}

The improvement category is ${proposal.category}.
Please generate the minimal code changes (files and content) required to implement this.
Return the result as a JSON array of { path: string, content: string }.`,
        recallMatches: [],
        knowledgeVaultMatches: []
      });

      // Extract JSON from reply
      const match = refactorReply.content.match(/\[[\s\S]*\]/);
      if (!match) throw new Error("Could not extract refactor JSON from LLM response");
      const changes = JSON.parse(match[0]) as { path: string, content: string }[];

      // 3. GitHub PR
      const branchName = `aaronclaw-refactor-${Date.now()}`;
      await pushFilesToGithub(
        input.env.GITHUB_TOKEN!,
        owner,
        repo,
        branchName,
        changes,
        `AaronClaw Autonomous Refactor: ${proposal.summary}`
      );

      await createPullRequest(
        input.env.GITHUB_TOKEN!,
        owner,
        repo,
        {
          title: `[AaronClaw] ${proposal.summary}`,
          body: `🧙🏾‍♂️ **Autonomous Structural Refactor Proposed by AaronClaw Architectura.**\n\n### Rationale\n${proposal.rationale}\n\n### Expected Benefit\n${proposal.expectedBenefit}\n\n*This PR was generated automatically following telemetric observation and internal reflection.*`,
          head: branchName,
          base: config.repoBranch || "main"
        }
      );

      succeededCount++;
    } catch (e) {
      console.error(`Managed Refactor: Failed for ${proposal.candidateKey}`, e);
      errorCount++;
    }
  }

  return {
    processedCount: candidates.length,
    succeededCount,
    errorCount
  };
}
/**
 * 🧙🏾‍♂️ Rich Hickey: Substrate Isolation (Sandboxing)
 * Provision isolated KV prefixes and scoped bindings to prevent identity-leakage
 * between autonomous session Hand executions.
 */
export function mountSubstrateSandbox(env: Env, handId: string): Env {
  const prefix = `hand:${handId}:`;

  const sandboxedEnv: Env = { ...env };

  // 1. Isolate CONFIG_KV if present
  if (env.CONFIG_KV) {
    sandboxedEnv.CONFIG_KV = {
      get: (key: string, options?: any) => env.CONFIG_KV!.get(`${prefix}${key}`, options),
      put: (key: string, value: any, options?: any) =>
        env.CONFIG_KV!.put(`${prefix}${key}`, value, options),
      delete: (key: string) => env.CONFIG_KV!.delete(`${prefix}${key}`),
      list: (options?: any) =>
        env.CONFIG_KV!.list({
          ...options,
          prefix: `${prefix}${options?.prefix ?? ""}`
        }),
      getWithMetadata: (key: string, options?: any) =>
        env.CONFIG_KV!.getWithMetadata(`${prefix}${key}`, options)
    } as KVNamespace;
  }

  // 2. Isolate R2 ARCHIVE if present
  if (env.ARCHIVE) {
    sandboxedEnv.ARCHIVE = {
      get: (key: string, options?: any) => env.ARCHIVE!.get(`${prefix}${key}`, options),
      put: (key: string, value: any, options?: any) =>
        env.ARCHIVE!.put(`${prefix}${key}`, value, options),
      delete: (key: string) => env.ARCHIVE!.delete(`${prefix}${key}`),
      list: (options?: any) =>
        env.ARCHIVE!.list({
          ...options,
          prefix: `${prefix}${options?.prefix ?? ""}`
        }),
      head: (key: string) => env.ARCHIVE!.head(`${prefix}${key}`)
    } as R2Bucket;
  }

  // 🧙🏾‍♂️ NOTE: D1 Isolation is achieved via the sessionId scoping in AaronDbEdgeSessionRepository.
  // We do not prefix table names as it would complect the schema logic.

  return sandboxedEnv;
}

async function runMeshCoordinatorHand(input: {
  env: Env;
  cron: string;
  timestamp: string;
}): Promise<{ assertedSignalCount: number; status: string }> {
  const repository = new AaronDbEdgeSessionRepository(input.env.AARONDB, buildHandSessionId("mesh-coordinator-hand"));
  
  // 1. Evaluate system health - query for recent failed runs across all hands
  const failedRuns = await listRecentFailedHandRuns({ env: input.env, excludedHandId: "mesh-coordinator-hand" });
  
  let assertedSignalCount = 0;
  
  // 2. If failures detected, assert a 'REPAIR_TRIGGER' signal for the Substrate Integrity Warden
  if (failedRuns.length > 0) {
    await repository.assertSignal({
      kind: "REPAIR_TRIGGER",
      payload: { failedCount: failedRuns.length, latestFailure: failedRuns[0].handId },
      target: "substrate-integrity-warden"
    });
    assertedSignalCount++;
  }
  
  // 3. Heartbeat signal for the mesh
  await repository.assertSignal({
    kind: "MESH_HEARTBEAT",
    payload: { cron: input.cron, timestamp: input.timestamp }
  });
  assertedSignalCount++;

  return {
    assertedSignalCount,
    status: failedRuns.length > 0 ? "degraded-coordinating" : "healthy"
  };
}

async function runSubstrateIntegrityWarden(input: {
  env: Env;
  cron: string;
  timestamp: string;
}): Promise<{ defectCount: number; correctionCount: number }> {
  const repository = new AaronDbEdgeSessionRepository(input.env.AARONDB, buildHandSessionId("substrate-integrity-warden"));
  
  // 1. Query for REPAIR_TRIGGER signals targeting this warden
  const signals = await repository.querySignals({
    kind: "REPAIR_TRIGGER",
    target: "substrate-integrity-warden"
  });
  
  let defectCount = 0;
  let correctionCount = 0;
  
  if (signals.length > 0) {
    // Audit logic: Check for session state consistency
    defectCount = signals.length;
    
    // Correction: Emit a 'MAINTENANCE_REQUIRED' signal
    await repository.assertSignal({
      kind: "MAINTENANCE_REQUIRED",
      payload: { reason: "Integrity Audit Triggered", evidence: signals[0].payload }
    });
    correctionCount++;
    
    // Explicitly run the orphan cleanup if defects found
    await runOrphanFactCleanup(input.env);
    correctionCount++;
  }

  return {
    defectCount,
    correctionCount
  };
}
