import { readProviderKeyStatus, type ProviderKeyValidationStatus } from "./provider-key-store";
import type { JsonObject } from "./session-state";
import { resolveSkillToolDefinitions, type SkillToolId, type ToolDefinition } from "./tool-policy";

export type SkillMemoryScope = "session-only" | "session-and-knowledge-vault";

interface SkillSecretManifest {
  id: string;
  label: string;
  provider: "gemini";
}

interface SkillManifest {
  id: string;
  label: string;
  description: string;
  manifestVersion: 1;
  installScope: "bundled-local-only";
  runtime: "cloudflare-worker";
  declaredTools: SkillToolId[];
  requiredSecrets: SkillSecretManifest[];
  memoryScope: SkillMemoryScope;
  promptInstructions: string[];
}

export interface BundledSkillCatalogEntry {
  id: string;
  label: string;
  requiredSecretIds: string[];
}

export interface ResolvedSkillSecretRequirement {
  id: string;
  label: string;
  source: "provider-key:gemini";
  configured: boolean;
  validationStatus: ProviderKeyValidationStatus;
  detail: string | null;
}

export interface ResolvedSkillManifest extends Omit<SkillManifest, "requiredSecrets"> {
  declaredToolDetails: ToolDefinition[];
  requiredSecrets: ResolvedSkillSecretRequirement[];
  readiness: "ready" | "missing-secrets";
  missingSecretIds: string[];
}

const bundledSkillManifests = [
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
      "Explains failures from bounded session, hand, audit, and runtime/provider evidence without expanding beyond declared read-only diagnostics.",
    manifestVersion: 1,
    installScope: "bundled-local-only",
    runtime: "cloudflare-worker",
    declaredTools: ["session-history", "hand-history", "audit-history", "runtime-state"],
    requiredSecrets: [],
    memoryScope: "session-only",
    promptInstructions: [
      "Diagnose failures from the provided evidence blocks and distinguish observed facts from hypotheses.",
      "Explain likely causes, confidence, and the next bounded operator checks without claiming hidden tools or hidden evidence."
    ]
  }
] as const satisfies readonly SkillManifest[];

export function getBundledSkillCatalog(): BundledSkillCatalogEntry[] {
  return bundledSkillManifests.map((manifest) => ({
    id: manifest.id,
    label: manifest.label,
    requiredSecretIds: manifest.requiredSecrets.map((secret) => secret.id)
  }));
}

export async function listBundledSkills(input: {
  env: Pick<Env, "AARONDB" | "APP_AUTH_TOKEN" | "GEMINI_API_KEY">;
}): Promise<ResolvedSkillManifest[]> {
  return Promise.all(bundledSkillManifests.map((manifest) => resolveSkillManifest(input.env, manifest)));
}

export async function readBundledSkillManifest(input: {
  env: Pick<Env, "AARONDB" | "APP_AUTH_TOKEN" | "GEMINI_API_KEY">;
  skillId: string;
}): Promise<ResolvedSkillManifest | null> {
  const manifest = bundledSkillManifests.find((candidate) => candidate.id === input.skillId) ?? null;
  return manifest ? resolveSkillManifest(input.env, manifest) : null;
}

export function buildSkillPromptAdditions(skill: ResolvedSkillManifest): string[] {
  return [
    [
      `Manifest-driven skill runtime: ${skill.label} (${skill.id}).`,
      `Description: ${skill.description}`,
      `Declared tools: ${skill.declaredToolDetails.map((tool) => `${tool.id} [${tool.policy}]`).join(", ") || "none"}.`,
      `Memory scope: ${describeSkillMemoryScope(skill.memoryScope)}.`,
      ...skill.promptInstructions.map((instruction, index) => `${index + 1}. ${instruction}`)
    ].join("\n")
  ];
}

export function buildSkillRuntimeMetadata(skill: ResolvedSkillManifest): JsonObject {
  return {
    skillId: skill.id,
    skillLabel: skill.label,
    skillInstallScope: skill.installScope,
    skillMemoryScope: skill.memoryScope,
    skillDeclaredTools: [...skill.declaredTools],
    skillDeclaredToolPolicies: skill.declaredToolDetails.map((tool) => ({
      id: tool.id,
      capability: tool.capability,
      policy: tool.policy,
      declarationMode: tool.declarationMode
    })),
    skillRequiredSecrets: skill.requiredSecrets.map((secret) => secret.id)
  };
}

function describeSkillMemoryScope(memoryScope: SkillMemoryScope): string {
  return memoryScope === "session-and-knowledge-vault"
    ? "session recall plus knowledge-vault recall"
    : "session recall only";
}

async function resolveSkillManifest(
  env: Pick<Env, "AARONDB" | "APP_AUTH_TOKEN" | "GEMINI_API_KEY">,
  manifest: SkillManifest
): Promise<ResolvedSkillManifest> {
  const declaredToolDetails = resolveSkillToolDefinitions(manifest.declaredTools);
  const requiredSecrets = await Promise.all(
    manifest.requiredSecrets.map(async (secret) => {
      const status = await readProviderKeyStatus({
        env,
        database: env.AARONDB,
        provider: secret.provider
      });

      return {
        id: secret.id,
        label: secret.label,
        source: "provider-key:gemini" as const,
        configured: status.configured,
        validationStatus: status.validation.status,
        detail: status.validation.detail
      };
    })
  );
  const missingSecretIds = requiredSecrets
    .filter((secret) => !secret.configured)
    .map((secret) => secret.id)
    .sort();

  return {
    ...manifest,
    declaredTools: [...manifest.declaredTools],
    declaredToolDetails,
    requiredSecrets,
    readiness: missingSecretIds.length > 0 ? "missing-secrets" : "ready",
    missingSecretIds
  };
}