import { AaronDbEdgeSessionRepository, type SessionRecord, type ToolEvent } from "./session-state";

const ALL_FACTS_SQL = `
  SELECT session_id, entity, attribute, value_json, tx, tx_index, occurred_at, operation
  FROM aarondb_facts
  WHERE session_id != ?
  ORDER BY session_id ASC, tx ASC, tx_index ASC
`;

const REFLECTION_PREFIX = "reflection:";
const MAINTENANCE_PREFIX = "maintenance:";
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

export interface SessionReflectionResult {
  sessionId: string;
  reflectionSessionId: string;
  summary: string;
  persisted: boolean;
  sourceLastTx: number;
}

export interface ScheduledMaintenanceResult {
  cron: string;
  maintenanceSessionId: string;
  reviewedSessionIds: string[];
  reflectedSessionIds: string[];
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
      sourceLastTx: 0
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
      sourceLastTx: sourceSession.lastTx
    };
  }

  const metrics = analyzeSession(sourceSession);
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
      unresolvedPromptCount: metrics.unresolvedPromptCount
    }
  });

  return {
    sessionId: input.sessionId,
    reflectionSessionId,
    summary,
    persisted: true,
    sourceLastTx: sourceSession.lastTx
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
      reviewedSessionIds
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
  return sessionId.startsWith(REFLECTION_PREFIX) || sessionId.startsWith(MAINTENANCE_PREFIX);
}

function previewEvent(event: SessionRecord["events"][number]): string {
  return event.kind === "message" ? event.content : `${event.toolName} ${event.summary}`;
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