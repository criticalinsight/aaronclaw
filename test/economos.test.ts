import { describe, it, expect } from "vitest";
import { auditEfficiency, getEconomosMetrics } from "../src/economos-engine";

describe("EconomosEngine", () => {
  describe("auditEfficiency", () => {
    it("should correctly count stateful places in the factory state", async () => {
      const mockState = new Map<string, Map<string, any>>();
      
      const entity1 = new Map<string, any>();
      entity1.set("attr1", "val1");
      entity1.set("attr2", "val2");
      
      const entity2 = new Map<string, any>();
      entity2.set("attr3", "val3");
      
      mockState.set("entity1", entity1);
      mockState.set("entity2", entity2);

      const metrics = await auditEfficiency({}, mockState);
      
      expect(metrics.totalStatefulPlaces).toBe(3);
      expect(metrics.overallEfficiencyScore).toBeGreaterThan(0);
      
      const architectureMetric = metrics.metrics.find(m => m.category === "Architecture");
      expect(architectureMetric).toBeDefined();
      expect(architectureMetric?.value).toBe(3);
      expect(architectureMetric?.status).toBe("optimal");
    });

    it("should return warning status if stateful places exceed threshold", async () => {
      const mockState = new Map<string, Map<string, any>>();
      const largeEntity = new Map<string, any>();
      for (let i = 0; i < 600; i++) {
        largeEntity.set(`attr${i}`, i);
      }
      mockState.set("large", largeEntity);

      const metrics = await auditEfficiency({}, mockState);
      const architectureMetric = metrics.metrics.find(m => m.category === "Architecture");
      expect(architectureMetric?.status).toBe("warning");
    });
  });

  describe("getEconomosMetrics", () => {
    it("should return a structured metrics object", async () => {
      const metrics = await getEconomosMetrics({});
      expect(metrics.overallEfficiencyScore).toBeDefined();
      expect(Array.isArray(metrics.metrics)).toBe(true);
      expect(metrics.metrics.length).toBeGreaterThan(0);
    });
  });
});
