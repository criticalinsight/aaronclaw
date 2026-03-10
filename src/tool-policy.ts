import type { JsonObject, JsonValue } from "./session-state";

export type ToolPolicy = "automatic-safe" | "operator-protected" | "admin-sensitive" | "scheduled-safe";
export type ToolAuditActor = "session-runtime" | "maintenance-runtime" | "hand-runtime" | "operator-route";
export type ToolAuditScope = "session" | "maintenance" | "hand" | "operator";
export type SkillToolId =
  | "session-recall"
  | "knowledge-vault"
  | "model-selection"
  | "session-history"
  | "hand-history"
  | "audit-history"
  | "runtime-state";
export type ToolId =
  | SkillToolId
  | "provider-key-management"
  | "hand-lifecycle"
  | "hand-run"
  | "improvement-candidate-review"
  | "improvement-proposal-review"
  | "improvement-shadow-evaluation"
  | "regression-watch-review"
  | "session-reflection"
  | "scheduled-maintenance"
  | "morning-briefing";

export interface ToolDefinition {
  id: ToolId;
  label: string;
  description: string;
  capability: string;
  policy: ToolPolicy;
  declarationMode: "skill-declared" | "core-runtime" | "operator-only" | "scheduled";
}

const TOOL_DEFINITIONS = {
  "session-recall": {
    id: "session-recall",
    label: "Session recall",
    description: "Reads prior session facts from the AaronDB-backed session history.",
    capability: "memory.read.session",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "knowledge-vault": {
    id: "knowledge-vault",
    label: "Knowledge vault",
    description: "Reads semantically relevant cross-session knowledge through the Cloudflare-native vault path.",
    capability: "memory.read.knowledge-vault",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "model-selection": {
    id: "model-selection",
    label: "Model selection",
    description: "Resolves the active assistant model/provider route for the current turn.",
    capability: "assistant.route.select",
    policy: "automatic-safe",
    declarationMode: "core-runtime"
  },
  "session-history": {
    id: "session-history",
    label: "Session history",
    description: "Reads recent session transcript and tool-event history for bounded diagnostics.",
    capability: "diagnostics.read.session-history",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "hand-history": {
    id: "hand-history",
    label: "Hand history",
    description: "Reads bundled hand lifecycle and recent run summaries for bounded diagnostics.",
    capability: "diagnostics.read.hand-history",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "audit-history": {
    id: "audit-history",
    label: "Audit history",
    description: "Reads persisted assistant and hand audit records for bounded diagnostics.",
    capability: "diagnostics.read.audit-history",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "runtime-state": {
    id: "runtime-state",
    label: "Runtime state",
    description: "Reads current model-selection and provider-readiness state for bounded diagnostics.",
    capability: "diagnostics.read.runtime-state",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "provider-key-management": {
    id: "provider-key-management",
    label: "Provider key management",
    description: "Writes or validates protected provider credentials.",
    capability: "operator.write.provider-keys",
    policy: "admin-sensitive",
    declarationMode: "operator-only"
  },
  "hand-lifecycle": {
    id: "hand-lifecycle",
    label: "Hand lifecycle",
    description: "Activates or pauses a bundled Cloudflare-native hand.",
    capability: "operator.control.hands",
    policy: "operator-protected",
    declarationMode: "operator-only"
  },
  "hand-run": {
    id: "hand-run",
    label: "Hand execution",
    description: "Executes a scheduled bundled hand and records the result.",
    capability: "hand.execute.scheduled",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "improvement-candidate-review": {
    id: "improvement-candidate-review",
    label: "Improvement candidate review",
    description: "Approves, rejects, pauses, promotes, or rolls back a stored improvement candidate.",
    capability: "operator.control.improvements",
    policy: "operator-protected",
    declarationMode: "operator-only"
  },
  "improvement-proposal-review": {
    id: "improvement-proposal-review",
    label: "Improvement proposal review",
    description: "Reviews stored reflection signals and writes structured improvement proposals.",
    capability: "improvement.propose.reflection",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "improvement-shadow-evaluation": {
    id: "improvement-shadow-evaluation",
    label: "Improvement shadow evaluation",
    description: "Runs bounded shadow/trial evaluation on stored improvement proposals before approval.",
    capability: "improvement.evaluate.shadow",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "regression-watch-review": {
    id: "regression-watch-review",
    label: "Regression watch review",
    description: "Detects bounded regression findings and writes evidence-backed follow-up proposals.",
    capability: "improvement.detect.regressions",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "session-reflection": {
    id: "session-reflection",
    label: "Session reflection",
    description: "Synthesizes a reflection artifact from existing session history.",
    capability: "maintenance.reflect.sessions",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "scheduled-maintenance": {
    id: "scheduled-maintenance",
    label: "Scheduled maintenance",
    description: "Runs the recurring maintenance pass over recent sessions.",
    capability: "maintenance.run.recurring",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "morning-briefing": {
    id: "morning-briefing",
    label: "Morning briefing",
    description: "Runs the morning briefing maintenance pass over recent sessions.",
    capability: "maintenance.run.briefing",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  }
} as const satisfies Record<ToolId, ToolDefinition>;

const SKILL_TOOL_IDS = new Set<SkillToolId>([
  "session-recall",
  "knowledge-vault",
  "model-selection",
  "session-history",
  "hand-history",
  "audit-history",
  "runtime-state"
]);

export function getToolDefinition(toolId: string): ToolDefinition | null {
  return toolId in TOOL_DEFINITIONS ? TOOL_DEFINITIONS[toolId as ToolId] : null;
}

export function resolveSkillToolDefinitions(toolIds: readonly SkillToolId[]): ToolDefinition[] {
  return toolIds.map((toolId) => TOOL_DEFINITIONS[toolId]);
}

export function isSkillToolAllowed(toolId: SkillToolId, declaredToolIds?: readonly SkillToolId[] | null): boolean {
  return !declaredToolIds || declaredToolIds.includes(toolId);
}

export function buildToolAuditRecord(input: {
  toolId: ToolId;
  actor: ToolAuditActor;
  scope: ToolAuditScope;
  outcome: "succeeded" | "blocked" | "failed";
  timestamp: string;
  detail?: string | null;
  sessionId?: string;
  handId?: string;
  skillId?: string;
  extra?: Record<string, JsonValue>;
}): JsonObject {
  const definition = TOOL_DEFINITIONS[input.toolId];

  return {
    auditVersion: 1,
    kind: "tool-audit",
    toolId: definition.id,
    toolLabel: definition.label,
    capability: definition.capability,
    policy: definition.policy,
    declarationMode: definition.declarationMode,
    actor: input.actor,
    scope: input.scope,
    outcome: input.outcome,
    timestamp: input.timestamp,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.handId ? { handId: input.handId } : {}),
    ...(input.skillId ? { skillId: input.skillId } : {}),
    ...(input.extra ?? {})
  };
}

export function isSkillToolId(value: string): value is SkillToolId {
  return SKILL_TOOL_IDS.has(value as SkillToolId);
}