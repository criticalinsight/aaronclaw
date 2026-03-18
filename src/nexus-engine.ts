import { AaronDbEdgeSessionRepository, type JsonObject, type KnowledgePattern } from "./session-state";
import { buildImprovementCandidateRecord, IMPROVEMENT_PROPOSAL_SESSION_ID } from "./reflection-engine";

const NEXUS_GLOBAL_SESSION_ID = "nexus:global";

export interface NexusDistillationResult {
  distilledCount: number;
  skippedCount: number;
  patterns: KnowledgePattern[];
}

export interface NexusIngestionResult {
  ingestedCount: number;
  signalsAsserted: number;
}

/**
 * 🧙🏾‍♂️ Knowledge Broadcaster: Distills local improvement proposals into anonymous patterns.
 */
export async function runKnowledgeBroadcaster(env: Env, timestamp: string): Promise<NexusDistillationResult> {
  const localPatternsRepo = new AaronDbEdgeSessionRepository(env.AARONDB, IMPROVEMENT_PROPOSAL_SESSION_ID);
  const globalNexusRepo = new AaronDbEdgeSessionRepository(env.AARONDB, NEXUS_GLOBAL_SESSION_ID);

  const localState = await localPatternsRepo.getSession();
  if (!localState) return { distilledCount: 0, skippedCount: 0, patterns: [] };

  // Query already distilled patterns in Nexus
  const existingPatterns = await globalNexusRepo.queryPatterns();
  const existingContexts = new Set(existingPatterns.map(p => JSON.stringify(p.context)));

  const distilledPatterns: KnowledgePattern[] = [];
  let skippedCount = 0;

  for (const event of localState.toolEvents) {
    if (event.toolName === "improvement-proposal" && event.metadata) {
      const distillationTx = event.tx;
      const context = event.metadata as JsonObject;
      
      // 🧙🏾‍♂️ Distill: Abstract the specific into the universal
      const pattern = await distillPattern(context);
      
      if (existingContexts.has(JSON.stringify(pattern))) {
        skippedCount++;
        continue;
      }

      await globalNexusRepo.assertPattern({
        summary: `Universal Pattern: ${event.summary}`,
        context: pattern,
        distillationTx
      });

      distilledPatterns.push({
        summary: event.summary,
        context: pattern,
        distillationTx,
        occurredAt: timestamp
      });
    }
  }

  return {
    distilledCount: distilledPatterns.length,
    skippedCount,
    patterns: distilledPatterns
  };
}

/**
 * 🧙🏾‍♂️ Structured Distillation: Removes concrete identities and extracts the structural essence.
 */
export async function distillPattern(context: JsonObject): Promise<JsonObject> {
  // 🧙🏾‍♂️ Structural Essence Extraction: 
  // We extract the 'shape' of the change, de-complecting it from specific line numbers or file paths.
  const blueprint: JsonObject = {
    category: context.category,
    structuralSignature: generateStructuralSignature(context.proposedFix as string),
    complexityReductionRatio: calculateComplexityYield(context),
    universalTags: deriveUniversalTags(context),
    synthesizedAt: new Date().toISOString()
  };

  return blueprint;
}

/**
 * 🧙🏾‍♂️ Generates a structural signature to identify similar de-complecting patterns.
 */
function generateStructuralSignature(code: string): string {
  // Simple signature: remove whitespace, comments, and normalize identifiers to types where possible
  // In future, this would be an AST-based hash.
  return code
    .replace(/\/\/.*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100); // Take the head of the structural change
}

/**
 * 🧙🏾‍♂️ Calculates the yield of a complexity reduction.
 */
function calculateComplexityYield(context: JsonObject): number {
  const impact = context.complexityImpact as string;
  if (impact === "low") return 0.2;
  if (impact === "medium") return 0.5;
  if (impact === "high") return 0.8;
  return 0.1;
}

/**
 * 🧙🏾‍♂️ Derives universal tags for global knowledge broadcast.
 */
function deriveUniversalTags(context: JsonObject): string[] {
  const tags = ["de-complecting"];
  if (context.category) tags.push(context.category as string);
  if (context.complexityImpact === "high") tags.push("architectural-pivot");
  return [...new Set(tags)];
}

/**
 * 🧙🏾‍♂️ Knowledge Subscriber: Ingests global patterns and asserts local synthesis signals.
 */
export async function runKnowledgeSubscriber(env: Env, timestamp: string): Promise<NexusIngestionResult> {
  const globalNexusRepo = new AaronDbEdgeSessionRepository(env.AARONDB, NEXUS_GLOBAL_SESSION_ID);
  const currentSessionRepo = new AaronDbEdgeSessionRepository(env.AARONDB, "session-runtime"); // Or similar target

  const globalPatterns = await globalNexusRepo.queryPatterns();
  const localSignals = await currentSessionRepo.querySignals({ kind: "SYNTHESIS_PROPOSAL" });
  const localPatternHistory = new Set(localSignals.map(s => JSON.stringify(s.payload)));

  let ingestedCount = 0;

  for (const pattern of globalPatterns) {
    if (localPatternHistory.has(JSON.stringify(pattern.context))) {
      continue;
    }

    // 🧙🏾‍♂️ Assert a synthesis signal for Sophia/Architectura to pick up
    await currentSessionRepo.assertSignal({
      kind: "SYNTHESIS_PROPOSAL",
      payload: pattern.context,
      target: "architectura"
    });

    ingestedCount++;
  }

  return {
    ingestedCount,
    signalsAsserted: ingestedCount
  };
}
