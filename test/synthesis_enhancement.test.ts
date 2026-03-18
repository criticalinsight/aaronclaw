import { describe, it, expect, vi } from "vitest";
import { distillPattern } from "../src/nexus-engine";
import { canRunEvolution } from "../src/economos-engine";
import * as economosEngine from "../src/economos-engine";
import { afterEach } from "vitest";

describe("Synthesis & Sustainability Enhancements", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  
  describe("Nexus: distillPattern", () => {
    it("should extract a structural signature and remove local context", async () => {
      const context = {
        category: "performance",
        proposedFix: "function optimize() {\n  // Heavy work\n  return 42;\n}",
        complexityImpact: "high",
        filePath: "/src/old/bottleneck.ts",
        lineNumbers: [10, 15]
      };

      const result = await distillPattern(context);

      expect(result.category).toBe("performance");
      expect(result.structuralSignature).toContain("function optimize()");
      expect(result.structuralSignature).not.toContain("// Heavy work"); // Comments removed
      expect(result.complexityReductionRatio).toBe(0.8);
      expect(result.universalTags).toContain("architectural-pivot");
      expect(result.universalTags).toContain("performance");
      expect(result.synthesizedAt).toBeDefined();
      
      // Ensure local context is gone (though my new implementation doesn't include them in the first place)
      expect(result.filePath).toBeUndefined();
      expect(result.lineNumbers).toBeUndefined();
    });
  });

  describe("Economos: canRunEvolution", () => {
    it("should block evolution if efficiency score is too low", async () => {
      vi.spyOn(economosEngine, "getEconomosMetrics").mockResolvedValue({
        overallEfficiencyScore: 80, // Threshold is 85
        totalStatefulPlaces: 100,
        latencyAnomalies: 0,
        metrics: [],
        timestamp: new Date().toISOString()
      });

      const canEvolve = await canRunEvolution({});
      expect(canEvolve).toBe(false);
    });

    it("should block evolution if architectural entropy is too high", async () => {
      vi.spyOn(economosEngine, "getEconomosMetrics").mockResolvedValue({
        overallEfficiencyScore: 90,
        totalStatefulPlaces: 600, // Threshold is 500
        latencyAnomalies: 0,
        metrics: [],
        timestamp: new Date().toISOString()
      });

      const canEvolve = await canRunEvolution({});
      expect(canEvolve).toBe(false);
    });

    it("should allow evolution for lean, efficient systems", async () => {
      vi.spyOn(economosEngine, "getEconomosMetrics").mockResolvedValue({
        overallEfficiencyScore: 95,
        totalStatefulPlaces: 50,
        latencyAnomalies: 0,
        metrics: [],
        timestamp: new Date().toISOString()
      });

      const canEvolve = await canRunEvolution({});
      expect(canEvolve).toBe(true);
    });
  });
});
