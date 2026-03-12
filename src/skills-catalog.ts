import { type SkillManifest } from "./skills-runtime";

export const bundledSkillManifests: SkillManifest[] = [
  {
    id: "aarondb-research",
    label: "AaronDB research skill",
    description:
      "Keeps answers grounded in session recall plus the existing Cloudflare-native knowledge-vault path.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "knowledge-vault"],
    requiredSecrets: [],
    memoryScope: "session-and-knowledge-vault",
    promptInstructions: [
      "Prefer evidence from warmed recall and knowledge-vault context over broad speculation.",
      "If the runtime evidence is thin, say so directly instead of inventing details."
    ]
  },
  {
    id: "gemini-review",
    label: "Gemini review skill",
    description:
      "Tightens response style for review work and requires Gemini key material without changing the Cloudflare runtime model.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "model-selection"],
    requiredSecrets: [{ id: "gemini-api-key", label: "Google Gemini API key", provider: "gemini" }],
    memoryScope: "session-only",
    promptInstructions: [
      "Keep review notes short, concrete, and grounded in the current request.",
      "Stay inside the declared tools and current session memory scope."
    ]
  },
  {
    id: "incident-triage",
    label: "Incident triage skill",
    description:
      "Explains failures from bounded session, hand, audit, and runtime/provider evidence.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-history", "hand-history", "audit-history", "runtime-state"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: [
      "Diagnose failures from the provided evidence blocks.",
      "Distinguish observed facts from hypotheses."
    ]
  },
  {
    id: "hickey-simplicity-lens",
    label: "Hickey simplicity lens",
    description: "Analyzes proposed code for 'complecting' patterns.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "hickey-simplicity-lens"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Focus on de-complecting state and logic."]
  },
  {
    id: "datalog-query-expert",
    label: "Datalog query expert",
    description: "Provides high-precision guidance for AaronDB.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "datalog-query-expert"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Explain Datalog joins and recursion clearly."]
  },
  {
    id: "rust-borrow-oracle",
    label: "Rust borrow oracle",
    description: "Specialized for FFI and Rust safety.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "rust-borrow-oracle"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Explain lifetimes and ownership."]
  },
  {
    id: "cloudflare-edge-architect",
    label: "Cloudflare edge architect",
    description: "Focused on Durable Object, D1, and Workers.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "cloudflare-edge-architect"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Optimize for DO residency and D1 latency."]
  },
  {
    id: "sqlite-migration-guide",
    label: "SQLite migration guide",
    description: "Expertise in designed idempotent D1 migrations.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "sqlite-migration-guide"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Ensure migrations are idempotent and reversible if possible."]
  },
  {
    id: "durable-object-migration-advisor",
    label: "Durable Object migration advisor",
    description: "Guidance for moving state to Workers substrate.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "durable-object-migration-advisor"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Explain the transition from server instances to DO identity."]
  },
  {
    id: "security-posture-audit",
    label: "Security posture audit",
    description: "Identifies permission gaps and sensitive exposures.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["audit-history", "security-posture-audit"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Audit for over-privileged tools or secrets."]
  },
  {
    id: "performance-tuning-skill",
    label: "Performance tuning skill",
    description: "Suggests latency optimizations.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["runtime-state", "performance-tuning-skill"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Identify bottlenecks in the tool-chain."]
  },
  {
    id: "gap-analysis-pro",
    label: "Gap analysis pro",
    description: "Compares implementations against specifications.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "gap-analysis-pro"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Map documentation facts to implementation facts."]
  },
  {
    id: "provenance-investigator",
    label: "Provenance investigator",
    description: "Traces history of a specific fact.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["audit-history", "provenance-investigator"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Trace facts back to the transaction root."]
  },
  {
    id: "automated-doc-writer",
    label: "Automated doc writer",
    description: "Formats runtime state into documentation.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["runtime-state", "automated-doc-writer"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Generate clean, Hickey-compliant markdown."]
  },
  {
    id: "test-scenario-designer",
    label: "Test scenario designer",
    description: "Proposes Vitest cases.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "test-scenario-designer"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Focus on edge cases and state transitions."]
  },
  {
    id: "de-coupling-assistant",
    label: "De-coupling assistant",
    description: "Identifies modules that should be split.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "de-coupling-assistant"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Flag intertwined state and logic."]
  },
  {
    id: "vendored-source-guide",
    label: "Vendored source guide",
    description: "Specialized for navigating vendor/ directory.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "vendored-source-guide"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Guide through AaronDB and other vendored slices."]
  },
  {
    id: "operational-economist",
    label: "Operational economist",
    description: "Analyzes cost/token trade-offs.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["runtime-state", "operational-economist"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Suggest cheaper models or logic paths."]
  },
  {
    id: "intent-clarifier",
    label: "Intent clarifier",
    description: "Helps operators clarify ambiguous goals.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-history", "intent-clarifier"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Identify conflicting operator signals."]
  },
  {
    id: "improvement-promoter",
    label: "Improvement promoter",
    description: "Guides review and promotion of candidates.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "improvement-promoter"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Promote verified, high-value improvements."]
  },
  {
    id: "vector-query-engineer",
    label: "Vector query engineer",
    description: "Optimizes hyper-recall queries.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["knowledge-vault", "vector-query-engineer"],
    requiredSecrets: [],
    memoryScope: "session-and-knowledge-vault",
    promptInstructions: ["Refine semantic search parameters."]
  },
  {
    id: "protocol-designer",
    label: "Protocol designer",
    description: "Assists in drafting internal APIs.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "protocol-designer"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Focus on idempotent, fact-based message formats."]
  },
  {
    id: "release-note-generator",
    label: "Release note generator",
    description: "Compiles transaction history into change logs.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["audit-history", "release-note-generator"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Summarize transaction roots for humans."]
  },
  {
    id: "state-visualization-oracle",
    label: "State visualization oracle",
    description: "Describes state transitions as DAGs.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "state-visualization-oracle"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Render logical state flows as Mermaid diagrams."]
  },
  {
    id: "shadow-eval-coordinator",
    label: "Shadow eval coordinator",
    description: "Manages testing of experimental skills.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["audit-history", "shadow-eval-coordinator"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Coordinate shadow testing without live effects."]
  },
  {
    id: "fact-integrity-checker",
    label: "Fact integrity checker",
    description: "Prevents assertion of contradictory facts.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "fact-integrity-checker"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Analyze proposed facts against existing truth log."]
  },
  {
    id: "substrate-migration-pro",
    label: "Substrate migration pro",
    description: "Advice on moving facts between buckets.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["runtime-state", "substrate-migration-pro"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Advise on D1 to R2 offloading."]
  },
  {
    id: "skill-prompt-optimizer",
    label: "Skill prompt optimizer",
    description: "Improves instructions for other skills.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "skill-prompt-optimizer"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: ["Tighten prompt context for higher impact."]
  },
  {
    id: "wrangler-orchestration",
    label: "Wrangler orchestration",
    description: "Expertise in managing Cloudflare deployments, generating wrangler.toml, and handling environment secrets.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-recall", "wrangler-orchestration"],
    requiredSecrets: [{ id: "cloudflare-api-token", label: "Cloudflare API Token", provider: "cloudflare" }],
    memoryScope: "session-only",
    promptInstructions: ["Generate correctly tuned wrangler.toml files.", "Manage secrets with extreme care."]
  }
];
