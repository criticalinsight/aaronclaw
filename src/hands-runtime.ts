import {
  runScheduledImprovementProposalReview,
  runScheduledMaintenance,
  scheduledMaintenanceCrons
} from "./reflection-engine";
import { AaronDbEdgeSessionRepository, type JsonObject, type ToolEvent } from "./session-state";
import { buildToolAuditRecord } from "./tool-policy";

const HAND_SESSION_PREFIX = "hand:";
const HAND_LIFECYCLE_TOOL = "hand-lifecycle";
const HAND_RUN_TOOL = "hand-run";
const MAX_RUN_HISTORY = 10;
const MAX_AUDIT_HISTORY = 10;

const bundledHands = [
  {
    id: "scheduled-maintenance",
    label: "Scheduled maintenance hand",
    description:
      "Reuses the existing reflection/maintenance path on Cloudflare cron triggers without introducing a separate runtime.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance, scheduledMaintenanceCrons.morningBriefing],
    implementation: "scheduled-maintenance"
  },
  {
    id: "improvement-hand",
    label: "Improvement Hand",
    description:
      "Periodically reviews stored reflection signals and writes bounded structured proposals into the improvement candidate store without mutating production behavior.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance, scheduledMaintenanceCrons.morningBriefing],
    implementation: "improvement-hand"
  }
] as const;

type BundledHandDefinition = (typeof bundledHands)[number];
type HandLifecycleAction = "activate" | "pause";
type HandRunStatus = "succeeded" | "failed";

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
  generatedProposalCount: number;
  skippedDuplicateProposalCount: number;
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
  env: Pick<Env, "AARONDB">;
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
  env: Pick<Env, "AARONDB">;
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

    const proposalReview = await runScheduledImprovementProposalReview({
      env: input.env,
      cron: input.cron,
      timestamp: input.timestamp
    });

    await repository.appendToolEvent({
      timestamp: input.timestamp,
      toolName: HAND_RUN_TOOL,
      summary: `${input.definition.label} reviewed ${proposalReview.reviewedSignalCount} stored signal(s) and wrote ${proposalReview.generatedProposalCount} structured proposal(s) for cron ${input.cron}.`,
      metadata: {
        action: "run",
        cron: input.cron,
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
            cron: input.cron,
            generatedProposalCount: proposalReview.generatedProposalCount,
            proposalSessionId: proposalReview.proposalSessionId,
            reviewedReflectionCount: proposalReview.reviewedReflectionSessionIds.length,
            reviewedSignalCount: proposalReview.reviewedSignalCount,
            skippedDuplicateProposalCount: proposalReview.skippedDuplicateProposalCount
          }
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
    generatedProposalCount:
      typeof event.metadata?.generatedProposalCount === "number" ? event.metadata.generatedProposalCount : 0,
    skippedDuplicateProposalCount:
      typeof event.metadata?.skippedDuplicateProposalCount === "number"
        ? event.metadata.skippedDuplicateProposalCount
        : 0,
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