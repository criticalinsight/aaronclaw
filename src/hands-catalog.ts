import { scheduledMaintenanceCrons } from "./reflection-engine";
import { runKnowledgeBroadcaster as runKnowledgeBroadcasterImpl, runKnowledgeSubscriber as runKnowledgeSubscriberImpl } from "./nexus-engine";
// Mock functions or wrappers if needed, but here we just point to the right place.
const runKnowledgeBroadcaster = runKnowledgeBroadcasterImpl;
const runKnowledgeSubscriber = runKnowledgeSubscriberImpl;
import { runDemiurgeMetaHand } from "./hands/demiurge-meta-hand";
import { runSovereignRebalanceHand } from "./hands/sovereign-rebalance-hand";
import { runEthicsAlignmentHand } from "./hands/ethics-alignment-hand";

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
  | "managed-refactor"
  | "synthetic-reflection-loop"
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
  | "fact-integrity-checker"
  | "substrate-migration-pro"
  | "skill-prompt-optimizer"
  | "wrangler-orchestration"
  | "prompt-injection-watchdog"
  | "reproducibility-guard"
  | "context-optimizer"
  | "sentiment-drift-watch"
  | "capability-mapper"
  | "knowledge-vault-pruner"
  | "compliance-sweeper"
  | "token-budget-enforcer"
  | "docs-factory"
  | "website-factory"
  | "github-coordinator"
  | "structural-hand-synthesis"
  | "mesh-coordinator-hand"
  | "substrate-integrity-warden"
  | "nexus-broadcaster-hand"
  | "nexus-subscriber-hand"
  | "demiurge-meta-hand"
  | "sovereign-rebalance"
  | "ethics-alignment";

export type HandId =
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
  | "github-coordinator"
  | "docs-factory"
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
  | "fact-integrity-checker"
  | "token-budget-enforcer"
  | "prompt-injection-watchdog"
  | "reproducibility-guard"
  | "context-optimizer"
  | "sentiment-drift-watch"
  | "capability-mapper"
  | "knowledge-vault-pruner"
  | "compliance-sweeper"
  | "website-factory"
  | "structural-hand-synthesis"
  | "managed-refactor"
  | "synthetic-reflection-loop"
  | "mesh-coordinator"
  | "substrate-warden"
  | "nexus-broadcaster"
  | "nexus-subscriber"
  | "demiurge-meta-hand"
  | "sovereign-rebalance"
  | "ethics-alignment";

export interface BundledHandDefinition {
  readonly id: HandId;
  readonly label: string;
  readonly description: string;
  readonly runtime: "cloudflare-cron" | "cloudflare-native";
  readonly scheduleCrons: readonly string[];
  readonly implementation: BundledHandImplementation;
  readonly run?: (env: any, timestamp: string) => Promise<any>;
}

export const bundledHandDefinitions: readonly BundledHandDefinition[] = [
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
      "Compares a bounded bundled docs contract against shipped documentation to detect drift.",
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
    id: "github-coordinator",
    label: "GitHub Coordinator",
    description: "Manages repository creation, branch strategies, and PR generation for self-spawning apps.",
    runtime: "cloudflare-cron",
    scheduleCrons: ["0 0 * * *"],
    implementation: "github-coordinator"
  },
  {
    id: "docs-factory",
    label: "Documentation Factory",
    description: "Autonomously generates and deploys the Schematic-styled docs site to GitHub and Cloudflare by extracting truth from the runtime catalogs.",
    runtime: "cloudflare-cron",
    scheduleCrons: ["0 0 * * *"],
    implementation: "docs-factory"
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
    id: "fact-integrity-checker",
    label: "Fact integrity checker",
    description: "Validates D1 and AaronDB schema parity.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "fact-integrity-checker"
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
  },
  {
    id: "website-factory",
    label: "Website Factory",
    description: "Synthesizes and deploys websites based on natural language prompts received from Telegram or other interfaces.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.morningBriefing],
    implementation: "website-factory"
  },
  {
    id: "structural-hand-synthesis",
    label: "Structural Hand Synthesis",
    description: "Autonomously distills successful trajectories into reusable system hands.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.morningBriefing],
    implementation: "structural-hand-synthesis"
  },
  {
    id: "managed-refactor",
    label: "Managed Refactor Hand",
    description: "Autonomously synthesizes and submits structural refactors to managed repositories based on telemetric approved findings.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "managed-refactor"
  },
  {
    id: "synthetic-reflection-loop",
    label: "Synthetic Reflection Loop",
    description: "Generates high-probability failure edge cases and chaos scenarios from successful trajectories to improve robustness.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.morningBriefing],
    implementation: "synthetic-reflection-loop"
  },
  {
    id: "mesh-coordinator",
    label: "Mesh Coordinator Hand",
    description: "Evaluates high-level system state and asserts MeshSignals to orchestrate autonomous Hand cooperation.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "mesh-coordinator-hand"
  },
  {
    id: "substrate-warden",
    label: "Substrate Integrity Warden",
    description: "Audits the shared AaronDB facts for signal contradictions or complected state.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "substrate-integrity-warden"
  },
  {
    id: "nexus-broadcaster",
    label: "Knowledge Broadcaster Hand",
    description: "Anonymously distills local improvement patterns and asserts them to the global Knowledge Nexus.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.morningBriefing],
    implementation: "nexus-broadcaster-hand"
  },
  {
    id: "nexus-subscriber",
    label: "Knowledge Subscriber Hand",
    description: "Queries the global Knowledge Nexus for distilled patterns and injects them into the local factory as synthesis signals.",
    runtime: "cloudflare-cron",
    scheduleCrons: [scheduledMaintenanceCrons.maintenance],
    implementation: "nexus-subscriber-hand"
  },
  {
    id: "demiurge-meta-hand",
    label: "Demiurge Meta-Hand",
    description: "Synthesizes new Hand implementations from Knowledge Nexus proposals and submits self-modifying PRs.",
    runtime: "cloudflare-cron",
    scheduleCrons: ["0 * * * *"],
    implementation: "demiurge-meta-hand",
    run: runDemiurgeMetaHand
  },
  {
    id: "sovereign-rebalance",
    label: "Sovereign Rebalance Hand",
    description: "Audits substrate drift and autonomously applies infrastructure fixes via the Sovereign Engine.",
    runtime: "cloudflare-cron",
    scheduleCrons: ["0 2 * * *"],
    implementation: "sovereign-rebalance",
    run: runSovereignRebalanceHand
  },
  {
    id: "ethics-alignment",
    label: "Ethics Alignment Hand",
    description: "Performs recursive purity checks to ensure the codebase aligns with Sovereign Ethics principles.",
    runtime: "cloudflare-cron",
    scheduleCrons: ["0 3 * * *"],
    implementation: "ethics-alignment",
    run: runEthicsAlignmentHand
  }
];