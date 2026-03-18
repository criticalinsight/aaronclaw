import { AaronDbEdgeSessionRepository, JsonObject } from "../session-state";
import { runTelemetricAudit, IMPROVEMENT_PROPOSAL_SESSION_ID } from "../reflection-engine";

/**
 * isolate-sentinel-hand
 * 🧙🏾‍♂️ Phase 23: Autonomous Isolate Guard.
 * Monitores telemetric pulses from managed projects (isolates) and triggers
 * self-healing or refactor proposals via AaronClaw's engines.
 */
export async function runIsolateSentinelHand(env: any, timestamp: string): Promise<JsonObject> {
  console.log("🛡️ Isolate Sentinel Hand: Auditing managed isolates...");

  const db = env.AARONDB;
  if (!db) {
    return { status: "error", message: "AARONDB not found in environment." };
  }

  try {
    // 1. Run the telemetric audit
    // This function already pulls managed projects, audits pulses via Economos/Sophia/Architectura,
    // and writes improvement proposals to the proposal session.
    const auditResult = await runTelemetricAudit({
      env: { AARONDB: db },
      cron: "isolate-sentinel",
      timestamp
    });

    // 2. Self-Healing Integration (Aeturnus)
    // If any project has critical reliability issues, we assert a high-priority healing signal.
    // In this implementation, we check the audit result (which we'd need to extend or query again).
    // For now, runTelemetricAudit handles the bulk of pattern recognition.

    return {
      status: "success",
      message: `Audited ${auditResult.managedProjectCount} project(s).`,
      managedProjectCount: auditResult.managedProjectCount,
      receivedPulseCount: auditResult.receivedPulseCount,
      generatedProposalCount: auditResult.generatedProposalCount,
      timestamp
    };
  } catch (error: any) {
    console.error("❌ Isolate Sentinel failed:", error);
    return { status: "error", message: error.message };
  }
}
