import { scheduledMaintenanceCrons } from "./reflection-engine";

export type BundledHandImplementation =
  | "scheduled-maintenance"
  | "improvement-hand"
  | "user-correction-miner"
  | "regression-watch"
  | "provider-health-watchdog"
  | "docs-drift";

export interface BundledHandDefinition {
  id: string;
  label: string;
  description: string;
  runtime: "cloudflare-cron";
  scheduleCrons: string[];
  implementation: BundledHandImplementation;
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
  }
] as const satisfies readonly BundledHandDefinition[];