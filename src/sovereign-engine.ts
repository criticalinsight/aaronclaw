import { JsonObject } from "./session-state";
import { discoverResources, ResourceMap, generateWranglerConfig } from "./wiring-engine";
import { createGithubRepository, pushFilesToGithub, setupGithubActions } from "./github-coordinator";

/**
 * 🧙🏾‍♂️ Sovereign Engine: The autonomic orchestrator of the factory's existence.
 * Manages the lifecycle of physical resources (Workers, D1, GitHub) based on architectural intent.
 */
export interface SovereignState {
  nodes: number;
  unhealthyNodes: number;
  lastRebalance: string;
  driftDetected: boolean;
}

export async function auditInfrastructureDrift(env: any, currentState: Map<string, Map<string, any>>): Promise<boolean> {
  // 🧙🏾‍♂️ Drift Detection: Comparing the "Intent" (AaronDB facts) with "Existence" (Wrangler/Env bindings)
  const discovered = discoverResources(env);
  
  // Minimal heuristic for Phase 11:
  // Are the domains declared in Aether actually powered by D1 bindings?
  for (const [entity, attributes] of currentState.entries()) {
    if (entity.startsWith('domain:')) {
      const domainName = entity.replace('domain:', '');
      // If a domain exists in intent but no D1 binding matches its expected storage name
      if (!discovered.d1.some(d1 => d1.includes(domainName))) {
        return true; // Drift detected
      }
    }
  }
  
  return false;
}

export async function rebalanceInfrastructure(env: any, currentState: Map<string, Map<string, any>>): Promise<JsonObject> {
  const drift = await auditInfrastructureDrift(env, currentState);
  
  if (!drift) {
    return { status: "stable", message: "Infrastructure matches intent." };
  }

  // 🧙🏾‍♂️ Autonomic Self-Healing:
  // In a real Sovereign implementation, we would call Wranglers API to provision D1.
  // For Phase 11, we generate the 'Existence Manifest' (Wrangler config) 
  // and prepare the GitHub PR for the infrastructure change.

  const discovered = discoverResources(env);
  const driftReport: string[] = [];
  
  for (const [entity, attributes] of currentState.entries()) {
    if (entity.startsWith('domain:')) {
      const domainName = entity.replace('domain:', '');
      if (!discovered.d1.some(d1 => d1.includes(domainName))) {
        driftReport.push(`Missing substrate for domain: ${domainName}`);
      }
    }
  }

  return {
    status: "rebalancing",
    action: "generate-migration-pr",
    report: driftReport,
    timestamp: new Date().toISOString()
  };
}

export function getSovereignMetrics(env: any, drift: boolean): SovereignState {
  const resources = discoverResources(env);
  return {
    nodes: resources.d1.length + resources.kv.length + 1, // +1 for the worker itself
    unhealthyNodes: drift ? 1 : 0,
    lastRebalance: new Date().toISOString(),
    driftDetected: drift
  };
}
