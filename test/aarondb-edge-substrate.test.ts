import { describe, expect, it } from "vitest";
import {
  AARONDB_EDGE_SUBSTRATE,
  buildAaronDbEdgeSubstrateStatus,
  compareAaronDbEdgeVectors,
  mountAaronDbEdgeSessionRuntime,
  measureAaronDbEdgeVectorBytes
} from "../src/aarondb-edge-substrate";

describe("aarondb-edge substrate seam", () => {
  it("documents the vendored upstream runtime slice", () => {
    expect(AARONDB_EDGE_SUBSTRATE).toMatchObject({
      strategy: "vendored-runtime-slice",
      repository: "criticalinsight/aarondb-edge",
      entrypoint: "vendor/aarondb-edge/src/index.mjs"
    });

    expect(buildAaronDbEdgeSubstrateStatus()).toMatchObject({
      runtimeSubstrate: "criticalinsight/aarondb-edge",
      runtimeSubstrateStrategy: "vendored-runtime-slice",
      runtimeSubstrateEntrypoint: "vendor/aarondb-edge/src/index.mjs",
      runtimeSubstrateBindings: expect.arrayContaining([
        expect.objectContaining({ upstream: "AARONDB_STATE", current: "SESSION_RUNTIME" }),
        expect.objectContaining({ upstream: "DB", current: "AARONDB" })
      ])
    });
  });

  it("reuses vendored upstream FFI helpers directly", () => {
    expect(compareAaronDbEdgeVectors([1, 0, 0], [0.8, 0.6, 0])).toBeGreaterThan(0.7);
    expect(measureAaronDbEdgeVectorBytes(new Float32Array([1, 2, 3]))).toBe(12);
  });

  it("mounts session runtime persistence through the approved substrate seam", async () => {
    const mount = mountAaronDbEdgeSessionRuntime(
      {
        AARONDB: {
          prepare() {
            return {
              bind() {
                return this;
              },
              all: async () => ({ results: [] }),
              run: async () => ({ success: true })
            };
          },
          batch: async () => []
        } as unknown as D1Database
      },
      {
        id: { toString: () => "do-session-1" } as DurableObjectId
      },
      "session-1"
    );

    expect(mount).toMatchObject({
      substrate: AARONDB_EDGE_SUBSTRATE,
      sessionId: "session-1",
      durableObjectId: "do-session-1",
      adapter: "compatibility-repository"
    });
    await expect(mount.repository.getSession()).resolves.toBeNull();
  });
});