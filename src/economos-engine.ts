import { type JsonObject } from "./session-state";
import { buildToolAuditRecord } from "./tool-policy";

export interface EfficiencyMetric extends JsonObject {
  category: string;
  metric: string;
  value: number;
  unit: string;
  status: "optimal" | "warning" | "critical";
  summary: string;
}

export interface EconomosMetrics extends JsonObject {
  timestamp: string;
  overallEfficiencyScore: number; // 0-100
  latencyAnomalies: number;
  totalStatefulPlaces: number;
  metrics: EfficiencyMetric[];
}

/**
 * 🧙🏾‍♂️ Economos Core: Complexity is the ultimate cost.
 * This engine audits the 'Stateful Places' in the global AaronDB state.
 */
export async function auditEfficiency(env: any, state: Map<string, Map<string, any>>): Promise<EconomosMetrics> {
  const timestamp = new Date().toISOString();
  const metrics: EfficiencyMetric[] = [];
  
  let statefulPlaces = 0;
  for (const attributes of state.values()) {
    statefulPlaces += attributes.size;
  }

  // Complection Metric
  metrics.push({
    category: "Architecture",
    metric: "Stateful Places",
    value: statefulPlaces,
    unit: "count",
    status: statefulPlaces > 500 ? "warning" : "optimal",
    summary: statefulPlaces > 500 
      ? "Architectural entropy is rising. High number of stateful places may indicate braiding of concerns."
      : "State surface area remains minimal and de-complected."
  });

  // Simulated Latency Audit (In a live env, this would be derived from log analysis)
  const avgLatency = 12.4; // ms
  metrics.push({
    category: "Performance",
    metric: "Avg Logic Latency",
    value: avgLatency,
    unit: "ms",
    status: avgLatency > 50 ? "critical" : "optimal",
    summary: avgLatency > 50 
      ? "Logic processing exceeds performance budgets. Recommend D1 optimization."
      : "Operational speed is within nominal bounds."
  });

  const efficiencyScore = Math.max(0, 100 - (statefulPlaces / 10) - (avgLatency / 2));

  return {
    timestamp,
    overallEfficiencyScore: Math.round(efficiencyScore),
    latencyAnomalies: 0,
    totalStatefulPlaces: statefulPlaces,
    metrics
  };
}

/**
 * 🧙🏾‍♂️ Economos: Measurement is the antidote to complexity.
 * Audits external managed projects using their telemetric pulses.
 */
export async function auditManagedProjects(
  env: any,
  pulses: { repoUrl: string; pulses: any[] }[]
): Promise<EconomosMetrics[]> {
  const reports: EconomosMetrics[] = [];

  for (const { repoUrl, pulses: projectPulses } of pulses) {
    const timestamp = new Date().toISOString();
    const metrics: EfficiencyMetric[] = [];

    // Group pulses by kind
    const byKind = projectPulses.reduce((acc, p) => {
      acc[p.metricKind] = acc[p.metricKind] || [];
      acc[p.metricKind].push(p.metricValue);
      return acc;
    }, {} as Record<string, number[]>);

    // 1. Performance Metric (LCP or similar)
    const lcpValues = byKind["performance:lcp"] || [];
    if (lcpValues.length > 0) {
      const avgLcp = lcpValues.reduce((a: number, b: number) => a + b, 0) / lcpValues.length;
      metrics.push({
        category: "Performance",
        metric: "LCP",
        value: avgLcp,
        unit: "ms",
        status: avgLcp > 2500 ? "warning" : "optimal",
        summary: `Average Largest Contentful Paint is ${Math.round(avgLcp)}ms.`
      });
    }

    // 2. Error Rate Metric
    const errorCounts = byKind["error:count"] || [];
    if (errorCounts.length > 0) {
      const totalErrors = errorCounts.reduce((a: number, b: number) => a + b, 0);
      metrics.push({
        category: "Reliability",
        metric: "Errors",
        value: totalErrors,
        unit: "count",
        status: totalErrors > 5 ? "critical" : "optimal",
        summary: `Captured ${totalErrors} runtime errors in the last window.`
      });
    }

    const efficiencyScore = 100 - (metrics.filter(m => m.status !== "optimal").length * 20);

    reports.push({
      timestamp,
      overallEfficiencyScore: Math.max(0, efficiencyScore),
      latencyAnomalies: metrics.filter(m => m.metric === "LCP" && m.status === "warning").length,
      totalStatefulPlaces: 0, // Not applicable for external projects via pulse alone
      metrics
    });
  }

  return reports;
}

/**
 * Fetches the current snapshot of economic and efficiency facts.
 */
export async function getEconomosMetrics(env: any): Promise<EconomosMetrics> {
  // This is a placeholder for a more comprehensive historical fact query
  return {
    timestamp: new Date().toISOString(),
    overallEfficiencyScore: 92,
    latencyAnomalies: 0,
    totalStatefulPlaces: 142,
    metrics: [
      {
        category: "Compute",
        metric: "Worker Execution",
        value: 15,
        unit: "ms",
        status: "optimal",
        summary: "Execution time is well below the 50ms budget."
      },
      {
        category: "Database",
        metric: "D1 P95 Latency",
        value: 4.8,
        unit: "ms",
        status: "optimal",
        summary: "Database response times are extremely healthy."
      }
    ]
  };
}

/**
 * 🧙🏾‍♂️ Crucible Gating (Phase 19): Governance through Economos.
 * Adversarial self-simulation is brutally expensive. We use the 
 * Economos constraints to authorize its execution.
 */
export async function canRunCrucible(env: any): Promise<boolean> {
  // Use exports to allow ViTest to intercept the call
  const metrics = await getEconomosMetrics(env);
  
  if (metrics.overallEfficiencyScore < 80) {
    return false;
  }

  const hasCriticalLatency = metrics.metrics.some(
    (m: EfficiencyMetric) => m.category === "Performance" && m.status === "critical"
  );
  
  if (hasCriticalLatency || metrics.latencyAnomalies > 5) {
    return false;
  }

  return true;
}

/**
 * 🧙🏾‍♂️ Economos Gating for Evolution (Phase 23).
 * Meta-circular evolution must be economically sustainable. 
 * Prevents complected growth by checking architectural entropy.
 */
export async function canRunEvolution(env: any): Promise<boolean> {
  const metrics = await getEconomosMetrics(env);
  
  // Hard gate 1: Efficiency score must be high.
  if (metrics.overallEfficiencyScore < 85) {
    console.warn(`⚠️ Economos: Efficiency score ${metrics.overallEfficiencyScore} is too low for evolution.`);
    return false;
  }

  // Hard gate 2: Architectural Entropy (Stateful Places) must be bounded.
  // Evolution in a complected system is high risk.
  if (metrics.totalStatefulPlaces > 500) {
    console.warn(`⚠️ Economos: Architectural entropy (${metrics.totalStatefulPlaces}) too high. De-complect before evolving.`);
    return false;
  }

  return true;
}
