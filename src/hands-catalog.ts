import { scheduledMaintenanceCrons } from "./reflection-engine";

export type BundledHandImplementation =
  | "scheduled-maintenance"
  | "improvement-hand"
  | "user-correction-miner"
  | "regression-watch"
  | "provider-health-watchdog"
  | "docs-drift"
  | "ttl-garbage-collector"
  | "orphan-fact-cleanup"
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

export interface BundledHandDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly runtime: "cloudflare-cron";
  readonly scheduleCrons: readonly string[];
  readonly implementation: BundledHandImplementation;
}

export const bundledHandDefinitions = [
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
  },
  {
    id: "user-correction-miner",
    label: "User Correction Miner",
    description:
      "Mines repeated user/operator corrections from recent session history, attaches bounded evidence, and writes review-only improvement proposals without mutating live behavior.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance, scheduledMaintenanceCrons.morningBriefing],
    implementation: "user-correction-miner"
  },
  {
    id: "regression-watch",
    label: "Regression Watch",
    description:
      "Detects bounded fallback/tool/hand regressions from existing session and hand history, then records evidence-backed findings for operator review.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance, scheduledMaintenanceCrons.morningBriefing],
    implementation: "regression-watch"
  },
  {
    id: "provider-health-watchdog",
    label: "Provider health watchdog",
    description:
      "Checks provider/model/key readiness plus recent chat and Telegram fallback signals, then persists structured operator-visible findings without mutating runtime state.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance, scheduledMaintenanceCrons.morningBriefing],
    implementation: "provider-health-watchdog"
  },
  {
    id: "docs-drift",
    label: "Docs drift hand",
    description:
      "Compares a bounded bundled docs contract against shipped runtime posture and records reviewable findings without editing repo docs automatically.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance, scheduledMaintenanceCrons.morningBriefing],
    implementation: "docs-drift"
  },
  {
    id: "ttl-garbage-collector",
    label: "TTL garbage collector",
    description: "Prunes facts that have exceeded their designated time-to-live.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "ttl-garbage-collector"
  },
  {
    id: "orphan-fact-cleanup",
    label: "Orphan fact cleanup",
    description: "Identifies and removes facts without valid provenance links.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "orphan-fact-cleanup"
  },
  {
    id: "vector-index-reconciler",
    label: "Vector index reconciler",
    description: "Ensures D1 facts are correctly mirrored in the Vectorize index.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "vector-index-reconciler"
  },
  {
    id: "daily-briefing-generator",
    label: "Daily briefing generator",
    description: "Compiles the morning brief for the operator.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.morningBriefing],
    implementation: "daily-briefing-generator"
  },
  {
    id: "error-cluster-detect",
    label: "Error cluster detector",
    description: "Groups recent tool failures into actionable clusters.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "error-cluster-detect"
  },
  {
    id: "credential-leak-watchdog",
    label: "Credential leak watchdog",
    description: "Scans for sensitive keys in audit logs.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "credential-leak-watchdog"
  },
  {
    id: "usage-spike-analyzer",
    label: "Usage spike analyzer",
    description: "Identifies anomalous token consumption.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "usage-spike-analyzer"
  },
  {
    id: "latent-reflection-miner",
    label: "Latent reflection miner",
    description: "Finds deep patterns in historic reflection sessions.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "latent-reflection-miner"
  },
  {
    id: "latency-anomaly-detector",
    label: "Latency anomaly detector",
    description: "Flags tools with degrading response times.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "latency-anomaly-detector"
  },
  {
    id: "tool-performance-baseline",
    label: "Tool performance baseline",
    description: "Establishes 'normal' timing for all tool executions.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "tool-performance-baseline"
  },
  {
    id: "stale-session-archiver",
    label: "Stale session archiver",
    description: "Moves old sessions to long-term storage.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "stale-session-archiver"
  },
  {
    id: "active-session-prewarmer",
    label: "Active session prewarmer",
    description: "Loads context for recently active sessions.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "active-session-prewarmer"
  },
  {
    id: "durable-object-storage-watch",
    label: "Durable Object storage watch",
    description: "Monitors storage limits for the runtime.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "durable-object-storage-watch"
  },
  {
    id: "dependency-drifter",
    label: "Dependency drifter",
    description: "Checks vendored source against upstream updates.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "dependency-drifter"
  },
  {
    id: "secret-rotation-check",
    label: "Secret rotation checker",
    description: "Reminds operator to rotate sensitive keys.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "secret-rotation-check"
  },
  {
    id: "audit-log-compactor",
    label: "Audit log compactor",
    description: "Compresses historic audit trials.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "audit-log-compactor"
  },
  {
    id: "schema-integrity-checker",
    label: "Schema integrity checker",
    description: "Validates D1 and AaronDB schema parity.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "schema-integrity-checker"
  },
  {
    id: "token-budget-enforcer",
    label: "Token budget enforcer",
    description: "Limits daily spend on LLM providers.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "token-budget-enforcer"
  },
  {
    id: "prompt-injection-watchdog",
    label: "Prompt injection watchdog",
    description: "Scans for jailbreak patterns in history.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "prompt-injection-watchdog"
  },
  {
    id: "reproducibility-guard",
    label: "Reproducibility guard",
    description: "Ensures similar inputs yielded similar results.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "reproducibility-guard"
  },
  {
    id: "context-optimizer",
    label: "Context optimizer",
    description: "Prunes noisy messages from session context.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "context-optimizer"
  },
  {
    id: "sentiment-drift-watch",
    label: "Sentiment drift watch",
    description: "Flags degrading helpfulness in AI responses.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "sentiment-drift-watch"
  },
  {
    id: "capability-mapper",
    label: "Capability mapper",
    description: "Updates the matrix of live tools and their health.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "capability-mapper"
  },
  {
    id: "knowledge-vault-pruner",
    label: "Knowledge vault pruner",
    description: "Removes duplicate or stale vector embeddings.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "knowledge-vault-pruner"
  },
  {
    id: "compliance-sweeper",
    label: "Compliance sweeper",
    description: "Ensures logs comply with data retention rules.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "compliance-sweeper"
  }
] as const satisfies readonly BundledHandDefinition[];