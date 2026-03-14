import { describe, expect, it, vi } from "vitest";
import { auditEfficiency, auditManagedProjects, canRunCrucible, EconomosMetrics } from "../src/economos-engine";
import * as economosEngine from "../src/economos-engine";

describe("economos-engine", () => {
  describe("auditEfficiency", () => {
    it("returns optimal metrics for a very lean state", async () => {
      const state = new Map([
        ["entity1", new Map([["attr1", "val1"]])]
      ]);
      const audit = await auditEfficiency({}, state);

      expect(audit.overallEfficiencyScore).toBeGreaterThan(90);
      expect(audit.totalStatefulPlaces).toBe(1);
      
      const compileMetric = audit.metrics.find((m) => m.metric === "Stateful Places");
      expect(compileMetric?.status).toBe("optimal");
    });
  });

  describe("canRunCrucible (Phase 19)", () => {
    it("returns false if score represents high entropy", async () => {
      vi.spyOn(economosEngine, "getEconomosMetrics").mockResolvedValue({
        overallEfficiencyScore: 70, // Below 80 boundary
        latencyAnomalies: 0,
        totalStatefulPlaces: 1000,
        metrics: [],
        timestamp: "2024-03-14T00:00:00Z"
      });
      expect(await canRunCrucible({})).toBe(false);
    });

    it("returns true for a lean resilient state", async () => {
      vi.spyOn(economosEngine, "getEconomosMetrics").mockResolvedValue({
        overallEfficiencyScore: 95,
        latencyAnomalies: 0,
        totalStatefulPlaces: 20,
        metrics: [],
        timestamp: "2024-03-14T00:00:00Z"
      });
      expect(await canRunCrucible({})).toBe(true);
    });
  });
});
