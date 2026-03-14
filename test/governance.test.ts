import { describe, it, expect } from "vitest";
import { buildImprovementCandidateRecord, ImprovementCandidateSeed, applyGovernanceBouncer } from "../src/reflection-engine";

// Note: In Vitest, we use describe/it blocks instead of a standalone async function.
describe("Phase 7: The Guardian - Complexity Governance", () => {
  it("should allow simple de-complecting proposals", () => {
    const timestamp = new Date().toISOString();
    const simpleSeed: ImprovementCandidateSeed = {
      candidateKey: "test:simple-refactor",
      summary: "Simplify the sync loop",
      problemStatement: "The sync loop is slightly over-engineered.",
      proposedAction: "Refactor the sync loop to use a more direct mapping and de-complect the transport.",
      expectedBenefit: "Higher maintainability and clearer intent.",
      riskLevel: "low",
      verificationPlan: "Verify sync integrity with unit tests.",
      derivedFromSignalKeys: [],
      evidence: [{
          kind: "message",
          summary: "Manual audit identified redundancy",
          eventId: null,
          tx: null,
          excerpt: null
      }],
      risk: {
        level: "low",
        summary: "Minimal risk during refactor."
      },
      verification: {
        status: "pending",
        summary: "Awaiting test run."
      }
    };

    const simpleRecord = buildImprovementCandidateRecord(simpleSeed, timestamp);
    console.log(`✅ Simple Proposal Score: ${simpleRecord.complectionScore}`);
    const simpleResult = applyGovernanceBouncer(simpleSeed);
    
    expect(simpleRecord.complectionScore).toBeLessThan(60);
    expect(simpleResult.passed).toBe(true);
  });

  it("should gate complex complected proposals", () => {
    const timestamp = new Date().toISOString();
    const complexSeed: ImprovementCandidateSeed = {
      candidateKey: "test:complex-wrapper",
      summary: "Add a proxy wrapper layer for intercepting events",
      problemStatement: "We need more interception points.",
      proposedAction: "Implement a cross-cutting proxy wrapper layer to intercept every state change and cache it in a secondary persistent store.",
      expectedBenefit: "More interception.",
      riskLevel: "medium",
      verificationPlan: "Manual verification.",
      derivedFromSignalKeys: ["s1", "s2", "s3", "s4", "s5", "s6"],
      evidence: [{
          kind: "message",
          summary: "Requirement for more logging",
          eventId: null,
          tx: null,
          excerpt: null
      }],
      risk: {
        level: "medium",
        summary: "Increased indirection."
      },
      verification: {
        status: "pending",
        summary: "Awaiting test run."
      }
    };

    const complexRecord = buildImprovementCandidateRecord(complexSeed, timestamp);
    console.log(`❌ Complex Proposal Score: ${complexRecord.complectionScore}`);
    const complexResult = applyGovernanceBouncer(complexSeed);
    
    expect(complexRecord.complectionScore).toBeGreaterThanOrEqual(60);
    expect(complexResult.passed).toBe(false);
    expect(complexResult.reason).toContain("Complexity threshold exceeded");
  });
});
