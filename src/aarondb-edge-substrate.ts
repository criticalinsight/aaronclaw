// @ts-ignore Vendored upstream runtime ships plain .mjs without TypeScript declarations.
import * as vendorFfi from "../vendor/aarondb-edge/src/aarondb_edge_ffi.mjs";
import {
  AaronDbEdgeSessionRepository,
  type SessionStateRepository
} from "./session-state";

const { byte_size, cosine_similarity, phash2 } = vendorFfi as {
  byte_size(bits: { buffer: ArrayBufferLike }): number;
  cosine_similarity(left: ArrayLike<number>, right: ArrayLike<number>): number;
  phash2(data: unknown): number;
};

const UPSTREAM_REPOSITORY = "criticalinsight/aarondb-edge";
const UPSTREAM_REF = "master@dafbba3f02da02c8812ef1026deb2062c41ea96b";

export const AARONDB_EDGE_SUBSTRATE = {
  strategy: "vendored-runtime-slice",
  repository: UPSTREAM_REPOSITORY,
  ref: UPSTREAM_REF,
  entrypoint: "vendor/aarondb-edge/src/index.mjs",
  migration: "vendor/aarondb-edge/migrations/0000_schema.sql",
  manifests: {
    packageJson: "vendor/aarondb-edge/package.json",
    gleamToml: "vendor/aarondb-edge/gleam.toml",
    manifestToml: "vendor/aarondb-edge/manifest.toml",
    wranglerToml: "vendor/aarondb-edge/wrangler.toml"
  },
  bindings: [
    {
      capability: "durable-object",
      upstream: "AARONDB_STATE",
      current: "SESSION_RUNTIME",
      status: "mapped"
    },
    { capability: "d1", upstream: "DB", current: "AARONDB", status: "mapped" },
    { capability: "ai", upstream: "AI", current: "AI", status: "mapped" },
    {
      capability: "kv",
      upstream: "CONFIG_KV",
      current: null,
      status: "not-mounted"
    },
    {
      capability: "vectorize",
      upstream: "VECTOR_INDEX",
      current: "VECTOR_INDEX",
      status: "mapped"
    },
    {
      capability: "r2",
      upstream: "ARCHIVE",
      current: null,
      status: "not-mounted"
    }
  ],
  agentRoutes: [
    "/",
    "/agents/:name/solve",
    "/agents/:name/coordinate",
    "/agents/:name/benchmark"
  ]
} as const;

export function buildAaronDbEdgeSubstrateStatus() {
  return {
    runtimeSubstrate: AARONDB_EDGE_SUBSTRATE.repository,
    runtimeSubstrateStrategy: AARONDB_EDGE_SUBSTRATE.strategy,
    runtimeSubstrateRef: AARONDB_EDGE_SUBSTRATE.ref,
    runtimeSubstrateEntrypoint: AARONDB_EDGE_SUBSTRATE.entrypoint,
    runtimeSubstrateSignature: String(
      phash2(
        `${AARONDB_EDGE_SUBSTRATE.strategy}:${AARONDB_EDGE_SUBSTRATE.ref}:${AARONDB_EDGE_SUBSTRATE.entrypoint}`
      )
    ),
    runtimeSubstrateAdapterStatus:
      "vendored source is mounted; the session Durable Object now mounts an AaronDB-backed compatibility adapter through this seam, and Hyper-Recall uses a Vectorize-capable knowledge-vault compatibility layer without changing the live session API.",
    runtimeSubstrateBindings: AARONDB_EDGE_SUBSTRATE.bindings,
    runtimeSubstrateRoutes: AARONDB_EDGE_SUBSTRATE.agentRoutes,
    runtimeSubstrateBuildImplications:
      "Upstream src/index.mjs imports generated Gleam JavaScript from build/dev/javascript. This repo now vendors the source slice directly; the next wave must either vendor built artifacts or add an explicit Gleam build bridge before replacing the live session repository."
  } as const;
}

export interface AaronDbEdgeSessionRuntimeMount {
  substrate: typeof AARONDB_EDGE_SUBSTRATE;
  sessionId: string;
  durableObjectId: string;
  adapter: "compatibility-repository";
  repository: SessionStateRepository;
}

export function mountAaronDbEdgeSessionRuntime(
  env: Pick<Env, "AARONDB">,
  state: Pick<DurableObjectState, "id">,
  sessionId: string
): AaronDbEdgeSessionRuntimeMount {
  return {
    substrate: AARONDB_EDGE_SUBSTRATE,
    sessionId,
    durableObjectId: state.id.toString(),
    adapter: "compatibility-repository",
    repository: new AaronDbEdgeSessionRepository(env.AARONDB, sessionId)
  };
}

export function compareAaronDbEdgeVectors(
  left: ArrayLike<number>,
  right: ArrayLike<number>
): number {
  return cosine_similarity(left, right);
}

export function fingerprintAaronDbEdgeValue(value: unknown): number {
  return phash2(value);
}

export function measureAaronDbEdgeVectorBytes(bits: { buffer: ArrayBufferLike }): number {
  return byte_size(bits);
}