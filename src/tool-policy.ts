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
  | "runtime-state"
  | "hickey-simplicity-lens"
  | "datalog-query-expert"
  | "rust-borrow-oracle"
  | "cloudflare-edge-architect"
  | "sqlite-migration-guide"
  | "durable-object-migration-advisor"
  | "security-posture-audit"
  | "performance-tuning-skill"
  | "gap-analysis-pro"
  | "provenance-investigator"
  | "automated-doc-writer"
  | "test-scenario-designer"
  | "de-coupling-assistant"
  | "vendored-source-guide"
  | "operational-economist"
  | "intent-clarifier"
  | "improvement-promoter"
  | "vector-query-engineer"
  | "protocol-designer"
  | "release-note-generator"
  | "state-visualization-oracle"
  | "shadow-eval-coordinator"
  | "fact-integrity-checker"
  | "substrate-migration-pro"
  | "skill-prompt-optimizer"
  | "wrangler-orchestration";
export type ToolId =
  | SkillToolId
  | "provider-key-management"
  | "hand-lifecycle"
  | "hand-run"
  | "hand-run-manual"
  | "improvement-candidate-review"
  | "improvement-proposal-review"
  | "improvement-shadow-evaluation"
  | "regression-watch-review"
  | "session-reflection"
  | "scheduled-maintenance"
  | "morning-briefing"
  | "ttl-garbage-collector"
  | "orphan-fact-cleanup"
  | "github-coordinator"
  | "vector-index-reconciler"
  | "daily-briefing-generator"
  | "error-cluster-detect"
  | "credential-leak-watchdog"
  | "usage-spike-analyzer"
  | "latent-reflection-miner"
  | "latency-anomaly-detector"
  | "tool-performance-baseline"
  | "stale-session-archiver"
  | "active-session-prewarmer"
  | "durable-object-storage-watch"
  | "dependency-drifter"
  | "secret-rotation-check"
  | "audit-log-compactor"
  | "schema-integrity-checker"
  | "token-budget-enforcer"
  | "prompt-injection-watchdog"
  | "reproducibility-guard"
  | "context-optimizer"
  | "sentiment-drift-watch"
  | "capability-mapper"
  | "knowledge-vault-pruner"
  | "compliance-sweeper";

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
  "hand-run-manual": {
    id: "hand-run-manual",
    label: "Manual hand execution",
    description: "Executes a bundled hand manually and records the result.",
    capability: "hand.execute.manual",
    policy: "operator-protected",
    declarationMode: "operator-only"
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
  },
  // --- New Hand Tools ---
  "ttl-garbage-collector": {
    id: "ttl-garbage-collector",
    label: "TTL garbage collector",
    description: "Enforces Time-To-Live on ephemeral session state.",
    capability: "hand.gc.ttl",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "orphan-fact-cleanup": {
    id: "orphan-fact-cleanup",
    label: "Orphan fact cleanup",
    description: "Identifies and flags facts without associated roots.",
    capability: "hand.cleanup.orphans",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "vector-index-reconciler": {
    id: "vector-index-reconciler",
    label: "Vector index reconciler",
    description: "Syncs missing D1 memory terms to the Cloudflare Vectorize index.",
    capability: "hand.sync.vector",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "daily-briefing-generator": {
    id: "daily-briefing-generator",
    label: "Daily briefing generator",
    description: "Distills previous day's facts into a briefing record.",
    capability: "hand.generate.briefing",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "error-cluster-detect": {
    id: "error-cluster-detect",
    label: "Error cluster detect",
    description: "Groups repeated tool-audit failures.",
    capability: "hand.detect.errors",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "credential-leak-watchdog": {
    id: "credential-leak-watchdog",
    label: "Credential leak watchdog",
    description: "Scans interactions for leaked secrets.",
    capability: "hand.watchdog.leaks",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "usage-spike-analyzer": {
    id: "usage-spike-analyzer",
    label: "Usage spike analyzer",
    description: "Detects anomalies in AI token consumption.",
    capability: "hand.analyze.usage",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "latent-reflection-miner": {
    id: "latent-reflection-miner",
    label: "Latent reflection miner",
    description: "Re-evaluates old reflections with newer models.",
    capability: "hand.mine.reflections",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "latency-anomaly-detector": {
    id: "latency-anomaly-detector",
    label: "Latency anomaly detector",
    description: "Monitors tool execution times for anomalies.",
    capability: "hand.detect.latency",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "tool-performance-baseline": {
    id: "tool-performance-baseline",
    label: "Tool performance baseline",
    description: "Aggregates latency values across tool runs.",
    capability: "hand.baseline.performance",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "stale-session-archiver": {
    id: "stale-session-archiver",
    label: "Stale session archiver",
    description: "Moves inactive sessions to cold storage.",
    capability: "hand.archive.sessions",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "active-session-prewarmer": {
    id: "active-session-prewarmer",
    label: "Active session prewarmer",
    description: "Predictively loads recent session metadata.",
    capability: "hand.prewarm.sessions",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "durable-object-storage-watch": {
    id: "durable-object-storage-watch",
    label: "Durable Object storage watch",
    description: "Monitors Durable Object storage utilization.",
    capability: "hand.watch.storage",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "dependency-drifter": {
    id: "dependency-drifter",
    label: "Dependency drifter",
    description: "Checks for updates in vendored slices.",
    capability: "hand.check.dependencies",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "secret-rotation-check": {
    id: "secret-rotation-check",
    label: "Secret rotation check",
    description: "Flags provider-key status for rotation.",
    capability: "hand.check.secrets",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "audit-log-compactor": {
    id: "audit-log-compactor",
    label: "Audit log compactor",
    description: "Summarizes fine-grained audit events.",
    capability: "hand.compact.audit",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "schema-integrity-checker": {
    id: "schema-integrity-checker",
    label: "Schema integrity checker",
    description: "Runs SQLite integrity checks.",
    capability: "hand.check.integrity",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "token-budget-enforcer": {
    id: "token-budget-enforcer",
    label: "Token budget enforcer",
    description: "Signals when nearing token consumption limits.",
    capability: "hand.enforce.budget",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "prompt-injection-watchdog": {
    id: "prompt-injection-watchdog",
    label: "Prompt injection watchdog",
    description: "Scans for malicious prompt injection attempts.",
    capability: "hand.detect.injection",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "reproducibility-guard": {
    id: "reproducibility-guard",
    label: "Reproducibility guard",
    description: "Verifies fact log replay consistency.",
    capability: "hand.verify.reproducibility",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "context-optimizer": {
    id: "context-optimizer",
    label: "Context optimizer",
    description: "Trims historical facts without losing intent.",
    capability: "hand.optimize.context",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "sentiment-drift-watch": {
    id: "sentiment-drift-watch",
    label: "Sentiment drift watch",
    description: "Mines for operator frustration signals.",
    capability: "hand.watch.sentiment",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "capability-mapper": {
    id: "capability-mapper",
    label: "Capability mapper",
    description: "Cross-references requested-but-missing tool IDs.",
    capability: "hand.map.capabilities",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "knowledge-vault-pruner": {
    id: "knowledge-vault-pruner",
    label: "Knowledge vault pruner",
    description: "Deletes low-utility recall terms.",
    capability: "hand.prune.vault",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  "compliance-sweeper": {
    id: "compliance-sweeper",
    label: "Compliance sweeper",
    description: "Verifies no PII is stored in the fact log.",
    capability: "hand.sweep.compliance",
    policy: "scheduled-safe",
    declarationMode: "scheduled"
  },
  // --- New Skill Tools ---
  "hickey-simplicity-lens": {
    id: "hickey-simplicity-lens",
    label: "Hickey simplicity lens",
    description: "Analyzes proposed code for 'complecting' patterns.",
    capability: "skill.analyze.simplicity",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "datalog-query-expert": {
    id: "datalog-query-expert",
    label: "Datalog query expert",
    description: "Provides high-precision guidance for AaronDB.",
    capability: "skill.query.datalog",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "rust-borrow-oracle": {
    id: "rust-borrow-oracle",
    label: "Rust borrow oracle",
    description: "Specialized for FFI and Rust safety.",
    capability: "skill.rust.oracle",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "cloudflare-edge-architect": {
    id: "cloudflare-edge-architect",
    label: "Cloudflare edge architect",
    description: "Focused on Durable Object, D1, and Workers.",
    capability: "skill.edge.architect",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "sqlite-migration-guide": {
    id: "sqlite-migration-guide",
    label: "SQLite migration guide",
    description: "Expertise in designed idempotent D1 migrations.",
    capability: "skill.guide.migration",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "durable-object-migration-advisor": {
    id: "durable-object-migration-advisor",
    label: "Durable Object migration advisor",
    description: "Guidance for moving state to Workers substrate.",
    capability: "skill.advisor.migration",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "security-posture-audit": {
    id: "security-posture-audit",
    label: "Security posture audit",
    description: "Identifies permission gaps and sensitive exposures.",
    capability: "skill.audit.security",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "performance-tuning-skill": {
    id: "performance-tuning-skill",
    label: "Performance tuning skill",
    description: "Suggests latency optimizations.",
    capability: "skill.tuning.performance",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "gap-analysis-pro": {
    id: "gap-analysis-pro",
    label: "Gap analysis pro",
    description: "Compares implementations against specifications.",
    capability: "skill.analyze.gaps",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "provenance-investigator": {
    id: "provenance-investigator",
    label: "Provenance investigator",
    description: "Traces history of a specific fact.",
    capability: "skill.investigate.provenance",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "automated-doc-writer": {
    id: "automated-doc-writer",
    label: "Automated doc writer",
    description: "Formats runtime state into documentation.",
    capability: "skill.write.docs",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "test-scenario-designer": {
    id: "test-scenario-designer",
    label: "Test scenario designer",
    description: "Proposes Vitest cases.",
    capability: "skill.design.tests",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "de-coupling-assistant": {
    id: "de-coupling-assistant",
    label: "De-coupling assistant",
    description: "Identifies modules that should be split.",
    capability: "skill.analyze.decoupling",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "vendored-source-guide": {
    id: "vendored-source-guide",
    label: "Vendored source guide",
    description: "Specialized for navigating vendor/ directory.",
    capability: "skill.guide.vendor",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "operational-economist": {
    id: "operational-economist",
    label: "Operational economist",
    description: "Analyzes cost/token trade-offs.",
    capability: "skill.analyze.cost",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "intent-clarifier": {
    id: "intent-clarifier",
    label: "Intent clarifier",
    description: "Helps operators clarify ambiguous goals.",
    capability: "skill.clarify.intent",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "improvement-promoter": {
    id: "improvement-promoter",
    label: "Improvement promoter",
    description: "Guides review and promotion of candidates.",
    capability: "skill.promote.improvements",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "vector-query-engineer": {
    id: "vector-query-engineer",
    label: "Vector query engineer",
    description: "Optimizes hyper-recall queries.",
    capability: "skill.query.vector",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "protocol-designer": {
    id: "protocol-designer",
    label: "Protocol designer",
    description: "Assists in drafting internal APIs.",
    capability: "skill.design.protocol",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "release-note-generator": {
    id: "release-note-generator",
    label: "Release note generator",
    description: "Compiles transaction history into change logs.",
    capability: "skill.generate.release-notes",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "state-visualization-oracle": {
    id: "state-visualization-oracle",
    label: "State visualization oracle",
    description: "Describes state transitions as DAGs.",
    capability: "skill.visualize.state",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "shadow-eval-coordinator": {
    id: "shadow-eval-coordinator",
    label: "Shadow eval coordinator",
    description: "Manages testing of experimental skills.",
    capability: "skill.coordinate.shadow",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "fact-integrity-checker": {
    id: "fact-integrity-checker",
    label: "Fact integrity checker",
    description: "Prevents assertion of contradictory facts.",
    capability: "skill.check.integrity",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "substrate-migration-pro": {
    id: "substrate-migration-pro",
    label: "Substrate migration pro",
    description: "Advice on moving facts between buckets.",
    capability: "skill.guide.substrate-migration",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "skill-prompt-optimizer": {
    id: "skill-prompt-optimizer",
    label: "Skill prompt optimizer",
    description: "Improves instructions for other skills.",
    capability: "skill.optimize.prompts",
    policy: "automatic-safe",
    declarationMode: "skill-declared"
  },
  "wrangler-orchestration": {
    id: "wrangler-orchestration",
    label: "Wrangler orchestration",
    description: "Manages Cloudflare deployments and secrets.",
    capability: "skill.manage.cloudflare-deploy",
    policy: "admin-sensitive",
    declarationMode: "skill-declared"
  },
  "github-coordinator": {
    id: "github-coordinator",
    label: "GitHub Coordinator",
    description: "Manages repository and PR lifecycle.",
    capability: "hand.manage.github",
    policy: "operator-protected",
    declarationMode: "core-runtime"
  }
} as const satisfies Record<ToolId, ToolDefinition>;

const SKILL_TOOL_IDS = new Set<SkillToolId>([
  "session-recall",
  "knowledge-vault",
  "model-selection",
  "session-history",
  "hand-history",
  "audit-history",
  "runtime-state",
  "hickey-simplicity-lens",
  "datalog-query-expert",
  "rust-borrow-oracle",
  "cloudflare-edge-architect",
  "sqlite-migration-guide",
  "durable-object-migration-advisor",
  "security-posture-audit",
  "performance-tuning-skill",
  "gap-analysis-pro",
  "provenance-investigator",
  "automated-doc-writer",
  "test-scenario-designer",
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
  "substrate-migration-pro",
  "skill-prompt-optimizer",
  "wrangler-orchestration"
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