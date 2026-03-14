import { describe, it, expect } from "vitest";
import { discoverPatterns, getSophiaYield, distillEvidence } from "../src/sophia-engine";
import { type EconomosMetrics } from "../src/economos-engine";
import { type SuccessEvidenceRecord } from "../src/reflection-engine";

describe("SophiaEngine", () => {
  describe("discoverPatterns", () => {
    it("should discover Domain Compression pattern when high efficiency is observed", async () => {
      const mockFacts = new Map<string, Map<string, any>>();
      const mockHistory: EconomosMetrics[] = [
        {
          timestamp: "2026-03-14T10:00:00Z",
          overallEfficiencyScore: 95,
          totalStatefulPlaces: 10,
          metrics: [],
          latencyAnomalies: 0
        },
        {
          timestamp: "2026-03-14T11:00:00Z",
          overallEfficiencyScore: 92,
          totalStatefulPlaces: 12,
          metrics: [],
          latencyAnomalies: 0
        }
      ];

      const yieldResult = await discoverPatterns({}, mockFacts, mockHistory);
      
      const pattern = yieldResult.patternsDiscovered.find(p => p.id === "pattern:domain-compression:v1");
      expect(pattern).toBeDefined();
      expect(pattern?.evidenceCount).toBe(2);
      expect(pattern?.confidence).toBeGreaterThan(0.5);
    });

    it("should discover Complection Avoidance pattern when low efficiency is observed", async () => {
      const mockFacts = new Map<string, Map<string, any>>();
      const mockHistory: EconomosMetrics[] = [
        {
          timestamp: "2026-03-14T12:00:00Z",
          overallEfficiencyScore: 65,
          totalStatefulPlaces: 500,
          metrics: [],
          latencyAnomalies: 0
        }
      ];

      const yieldResult = await discoverPatterns({}, mockFacts, mockHistory);
      
      const pattern = yieldResult.patternsDiscovered.find(p => p.id === "pattern:complection-avoidance:v1");
      expect(pattern).toBeDefined();
      expect(pattern?.confidence).toBe(0.8);
    });
  });

  describe("distillEvidence", () => {
    it("should assign high confidence and promote hand if orbit resolved quickly", async () => {
      const evidence: SuccessEvidenceRecord[] = [
        {
          kind: "success-orbit",
          sessionId: "test-session-123",
          timestamp: "2026-03-14T10:00:00Z",
          summary: "Orbit resolved quickly.",
          trajectory: {
            intent: "Add a new button",
            outcome: "RESOLVED",
            steps: 2 // 1.0 - (2 * 0.05) = 0.9 confidence > 0.85
          }
        }
      ];

      const proposals = await distillEvidence({}, evidence);
      
      expect(proposals.length).toBe(1);
      const proposal = proposals[0];
      expect(proposal.confidence).toBe(0.9);
      expect(proposal.status).toBe("promoted");
    });

    it("should assign lower confidence and keep status as distilled if orbit took many steps", async () => {
      const evidence: SuccessEvidenceRecord[] = [
        {
          kind: "success-orbit",
          sessionId: "test-session-456",
          timestamp: "2026-03-14T10:00:00Z",
          summary: "Orbit took a long time.",
          trajectory: {
            intent: "Build a complex feature",
            outcome: "RESOLVED",
            steps: 10 // 1.0 - (10 * 0.05) = 0.5 confidence < 0.85
          }
        }
      ];

      const proposals = await distillEvidence({}, evidence);
      
      expect(proposals.length).toBe(1);
      const proposal = proposals[0];
      expect(proposal.confidence).toBe(0.5);
      expect(proposal.status).toBe("distilled");
    });
  });

  describe("getSophiaYield", () => {
    it("should return meta-reflection pattern by default", async () => {
      const yieldResult = await getSophiaYield({});
      expect(yieldResult.totalKnowledgeYield).toBeGreaterThan(0);
      expect(yieldResult.patternsDiscovered[0].name).toBe("Recursive Reflection");
    });
  });
});
