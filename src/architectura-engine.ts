import { type JsonObject } from "./session-state";
import { type SophiaYield, type KnowledgePattern } from "./sophia-engine";
import { type EconomosMetrics } from "./economos-engine";

export interface RefactorProposition extends JsonObject {
  id: string;
  targetModule: string;
  type: "DOMAIN_ISOLATION" | "STATE_DECOUPLING" | "INTERFACE_SIMPLIFICATION";
  rationale: string;
  evidenceId: string; // ID of the Sophia pattern
  estimatedSimplicityGain: number; // Percentage
  status: "PROPOSED" | "REVIEWED" | "EXECUTED" | "REJECTED";
}

export interface ArchitecturaReport extends JsonObject {
  timestamp: string;
  propositions: RefactorProposition[];
  activeOptimizationLoop: boolean;
}

/**
 * 🧙🏾‍♂️ Architectura: Change is not improvement unless it removes complection.
 * Proposes structural migrations based on architectural intelligence.
 */
export async function proposeOptimizations(
  env: any,
  sophiaYield: SophiaYield,
  economosMetrics: EconomosMetrics
): Promise<ArchitecturaReport> {
  const timestamp = new Date().toISOString();
  const propositions: RefactorProposition[] = [];

  // Logic: If Economos says "High Complexity" and Sophia says "Domain Compression pattern exists",
  // we propose a DOMAIN_ISOLATION refactor.
  
  const highComplexity = (economosMetrics.totalStatefulPlaces ?? 0) > 100;
  const compressionPattern = sophiaYield.patternsDiscovered.find(p => p.id === "pattern:domain-compression:v1");

  if (highComplexity && compressionPattern) {
    propositions.push({
      id: `refactor:${Date.now()}:domain-isolation`,
      targetModule: "src/session-state.ts", // Example hotspot
      type: "DOMAIN_ISOLATION",
      rationale: `Complexity score of ${economosMetrics.totalStatefulPlaces} exceeds threshold. Sophia implies Domain Compression is viable here.`,
      evidenceId: compressionPattern.id,
      estimatedSimplicityGain: 25.0,
      status: "PROPOSED"
    });
  }

  // Logic: Decoupling State if efficiency is low
  if (economosMetrics.overallEfficiencyScore < 85) {
    propositions.push({
      id: `refactor:${Date.now()}:state-decoupling`,
      targetModule: "src/index.ts",
      type: "STATE_DECOUPLING",
      rationale: "Overall efficiency dip detected. Reducing coupling between request handlers and global state.",
      evidenceId: "pattern:recursive-reflection:v1",
      estimatedSimplicityGain: 15.5,
      status: "PROPOSED"
    });
  }

  return {
    timestamp,
    propositions,
    activeOptimizationLoop: propositions.length > 0
  };
}

/**
 * 🧙🏾‍♂️ Architectura: Change is not improvement unless it removes complection.
 * Proposes structural migrations based on architectural intelligence.
 */
export async function proposeExternalOptimizations(
  env: any,
  managedProjects: { repoUrl: string; patterns: KnowledgePattern[]; metrics: EconomosMetrics }[]
): Promise<RefactorProposition[]> {
  const allPropositions: RefactorProposition[] = [];

  for (const { repoUrl, patterns, metrics } of managedProjects) {
    // Logic: High error rates in Reliability -> Suggest DOMAIN_ISOLATION
    const hasCritError = metrics.metrics.find(m => m.category === "Reliability" && m.status === "critical");
    const stabilityPattern = patterns.find(p => p.id.startsWith("pattern:stability-drift"));

    if (hasCritError && stabilityPattern) {
      allPropositions.push({
        id: `refactor:${Date.now()}:external-isolation:${repoUrl}`,
        targetModule: `${repoUrl}/src/**`,
        type: "DOMAIN_ISOLATION",
        rationale: `Critical stability drift detected in ${repoUrl}. High error volume suggests complected state.`,
        evidenceId: stabilityPattern.id,
        estimatedSimplicityGain: 35.0,
        status: "PROPOSED"
      });
    }

    // Logic: Performance warning -> Suggest INTERFACE_SIMPLIFICATION
    const hasPerfWarn = metrics.metrics.find(m => m.category === "Performance" && m.status === "warning");
    const perfPattern = patterns.find(p => p.id.startsWith("pattern:lcp-spike"));

    if (hasPerfWarn && perfPattern) {
      allPropositions.push({
        id: `refactor:${Date.now()}:external-performance:${repoUrl}`,
        targetModule: `${repoUrl}/src/App.tsx`,
        type: "INTERFACE_SIMPLIFICATION",
        rationale: `Performance spike in ${repoUrl} metrics. Recommend simplifying interaction interfaces and reducing bundle bloat.`,
        evidenceId: perfPattern.id,
        estimatedSimplicityGain: 20.0,
        status: "PROPOSED"
      });
    }
  }

  return allPropositions;
}

/**
 * Fetches current optimization propositions.
 */
export async function getArchitecturaPropositions(env: any): Promise<ArchitecturaReport> {
  return {
    timestamp: new Date().toISOString(),
    propositions: [
      {
        id: "refactor:baseline:optimizer",
        targetModule: "factory:core",
        type: "INTERFACE_SIMPLIFICATION",
        rationale: "Initial structural alignment following Transcendence Horizon initiation.",
        evidenceId: "pattern:recursive-reflection:v1",
        estimatedSimplicityGain: 10.0,
        status: "REVIEWED"
      }
    ],
    activeOptimizationLoop: true
  };
}
