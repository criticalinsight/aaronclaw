import { describe, expect, it, vi } from "vitest";
import { EconomosBudgetExceededError, runAdversarialSimulation } from "../src/crucible-engine";
import * as economosEngine from "../src/economos-engine";
import { afterEach } from "vitest";

describe("Crucible Engine (Phase 19)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects simulation if Economos gate returns false", async () => {
    vi.spyOn(economosEngine, "canRunCrucible").mockResolvedValue(false);

    await expect(runAdversarialSimulation({})).rejects.toThrow(EconomosBudgetExceededError);
  });

  it("permits simulation if Economos gate returns true", async () => {
    vi.spyOn(economosEngine, "canRunCrucible").mockResolvedValue(true);

    const result = await runAdversarialSimulation({});
    expect(result.status).toBe("Shadow testing complete");
    expect(result.simulationId).toContain("crucible-");
  });
});
