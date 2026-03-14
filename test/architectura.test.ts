import { describe, it, expect } from "vitest";
import { proposeOptimizations } from "../src/architectura-engine";
import { type SophiaYield } from "../src/sophia-engine";
import { type EconomosMetrics } from "../src/economos-engine";

describe("ArchitecturaEngine", () => {
  describe("proposeOptimizations", () => {
    it("should propose DOMAIN_ISOLATION when complexity is high and compression pattern exists", async () => {
      const mockSophia: SophiaYield = {
        timestamp: "any",
        totalKnowledgeYield: 1,
        patternsDiscovered: [
          {
            id: "pattern:domain-compression:v1",
            name: "Domain Compression",
            description: "desc",
            evidenceCount: 1,
            avgEfficiencyGain: 10,
            confidence: 0.9,
            suggestedSkillId: "skill:1"
          }
        ]
      };

      const mockEconomos: EconomosMetrics = {
        timestamp: "any",
        overallEfficiencyScore: 90,
        totalStatefulPlaces: 150, // High complexity
        metrics: [],
        latencyAnomalies: 0
      };

      const report = await proposeOptimizations({}, mockSophia, mockEconomos);
      
      const prop = report.propositions.find(p => p.type === "DOMAIN_ISOLATION");
      expect(prop).toBeDefined();
      expect(prop?.targetModule).toBe("src/session-state.ts");
      expect(prop?.status).toBe("PROPOSED");
    });

    it("should propose STATE_DECOUPLING when efficiency is low", async () => {
      const mockSophia: SophiaYield = {
        timestamp: "any",
        totalKnowledgeYield: 0,
        patternsDiscovered: []
      };

      const mockEconomos: EconomosMetrics = {
        timestamp: "any",
        overallEfficiencyScore: 70, // Low efficiency
        totalStatefulPlaces: 10,
        metrics: [],
        latencyAnomalies: 0
      };

      const report = await proposeOptimizations({}, mockSophia, mockEconomos);
      
      const prop = report.propositions.find(p => p.type === "STATE_DECOUPLING");
      expect(prop).toBeDefined();
      expect(prop?.estimatedSimplicityGain).toBe(15.5);
    });
  });
});
