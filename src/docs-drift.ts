import { bundledHandDefinitions } from "./hands-catalog";
import { resolveModelSelection } from "./model-registry";
import { buildBootstrapStatus } from "./routes";
import type { JsonObject } from "./session-state";
import { getBundledSkillCatalog } from "./skills-runtime";

type DocsDriftKind = "hand-posture" | "skill-posture" | "operator-route" | "model-posture";
type DocsDriftSeverity = "medium" | "high";

interface DocsClaimSource extends JsonObject {
  path: string;
  section: string;
  excerpt: string;
}

interface DocsContractSetClaim {
  source: DocsClaimSource;
  values: string[];
}

interface DocsContractValueClaim {
  source: DocsClaimSource;
  value: string;
}

export interface DocsContract {
  documentedHands: DocsContractSetClaim;
  documentedSkills: DocsContractSetClaim;
  documentedOperatorRoutes: DocsContractSetClaim;
  defaultRequestedProvider: DocsContractValueClaim;
}

interface DocsDriftEvidence extends JsonObject {
  kind: "docs" | "runtime";
  summary: string;
  detail: string;
}

export interface DocsDriftFinding extends JsonObject {
  findingKey: string;
  kind: DocsDriftKind;
  severity: DocsDriftSeverity;
  summary: string;
  recommendedReview: string;
  source: DocsClaimSource;
  evidence: DocsDriftEvidence[];
}

export interface DocsDriftReviewResult {
  cron: string;
  reviewedDocumentCount: number;
  reviewedClaimCount: number;
  findingCount: number;
  findings: DocsDriftFinding[];
  summary: string;
}

export const defaultDocsContract: DocsContract = {
  documentedHands: {
    source: {
      path: "public/docs/setup.md",
      section: "What to expect locally",
      excerpt:
        "The bundled hands currently shipped are `scheduled-maintenance`, `improvement-hand`, `user-correction-miner`, `regression-watch`, `provider-health-watchdog`, `docs-drift`, `ttl-garbage-collector`, `orphan-fact-cleanup`, `vector-index-reconciler`, `daily-briefing-generator`, `github-coordinator`, `docs-factory`, `error-cluster-detect`, `credential-leak-watchdog`, `usage-spike-analyzer`, `latent-reflection-miner`, `latency-anomaly-detector`, `tool-performance-baseline`, `stale-session-archiver`, `active-session-prewarmer`, `durable-object-storage-watch`, `dependency-drifter`, `secret-rotation-check`, `audit-log-compactor`, `schema-integrity-checker`, `token-budget-enforcer`, `prompt-injection-watchdog`, `reproducibility-guard`, `context-optimizer`, `sentiment-drift-watch`, `capability-mapper`, `knowledge-vault-pruner`, `compliance-sweeper`, `structural-hand-synthesis`, and `website-factory`; each remains paused until an operator activates it."
    },
    values: [
      "scheduled-maintenance",
      "improvement-hand",
      "user-correction-miner",
      "regression-watch",
      "provider-health-watchdog",
      "docs-drift",
      "ttl-garbage-collector",
      "orphan-fact-cleanup",
      "vector-index-reconciler",
      "daily-briefing-generator",
      "github-coordinator",
      "docs-factory",
      "error-cluster-detect",
      "credential-leak-watchdog",
      "usage-spike-analyzer",
      "latent-reflection-miner",
      "latency-anomaly-detector",
      "tool-performance-baseline",
      "stale-session-archiver",
      "active-session-prewarmer",
      "durable-object-storage-watch",
      "dependency-drifter",
      "secret-rotation-check",
      "audit-log-compactor",
      "schema-integrity-checker",
      "token-budget-enforcer",
      "prompt-injection-watchdog",
      "reproducibility-guard",
      "context-optimizer",
      "sentiment-drift-watch",
      "capability-mapper",
      "knowledge-vault-pruner",
      "compliance-sweeper",
      "structural-hand-synthesis",
      "website-factory"
    ]
  },
  documentedSkills: {
    source: {
      path: "public/docs/setup.md",
      section: "What to expect locally",
      excerpt:
        "The bundled skills currently shipped are `aarondb-research`, `gemini-review`, `incident-triage`, `hickey-simplicity-lens`, `datalog-query-expert`, `rust-borrow-oracle`, `cloudflare-edge-architect`, `sqlite-migration-guide`, `durable-object-migration-advisor`, `security-posture-audit`, `performance-tuning-skill`, `gap-analysis-pro`, `provenance-investigator`, `automated-doc-writer`, `test-scenario-designer`, `de-coupling-assistant`, `vendored-source-guide`, `operational-economist`, `intent-clarifier`, `improvement-promoter`, `vector-query-engineer`, `protocol-designer`, `release-note-generator`, `state-visualization-oracle`, `shadow-eval-coordinator`, `fact-integrity-checker`, `substrate-migration-pro`, `skill-prompt-optimizer`, and `wrangler-orchestration`."
    },
    values: [
      "aarondb-research",
      "gemini-review",
      "incident-triage",
      "hickey-simplicity-lens",
      "datalog-query-expert",
      "rust-borrow-oracle",
      "cloudflare-edge-architect",
      "sqlite-migration-guide",
      "durable-object-migration-advisor",
      "security-posture-audit",
      "performance-tuning-skill",
      "gap-analysis-pro",
      "provenance-investigator",
      "automated-doc-writer",
      "test-scenario-designer",
      "de-coupling-assistant",
      "vendored-source-guide",
      "operational-economist",
      "intent-clarifier",
      "improvement-promoter",
      "vector-query-engineer",
      "protocol-designer",
      "release-note-generator",
      "state-visualization-oracle",
      "shadow-eval-coordinator",
      "fact-integrity-checker",
      "substrate-migration-pro",
      "skill-prompt-optimizer",
      "wrangler-orchestration"
    ]
  },
  documentedOperatorRoutes: {
    source: {
      path: "public/docs/runtime.md",
      section: "Operator settings routes",
      excerpt:
        "GET/POST /api/model, GET/POST /api/key, GET /api/improvements, GET /api/improvements/:proposalKey, POST /api/improvements/:proposalKey/approve, POST /api/improvements/:proposalKey/reject, POST /api/improvements/:proposalKey/pause, GET /api/hands, GET /api/hands/:id, POST /api/hands/:id/activate, POST /api/hands/:id/pause, GET /api/skills, GET /api/skills/:id."
    },
    values: [
      "GET /api/model",
      "POST /api/model",
      "GET /api/key",
      "POST /api/key",
      "GET /api/improvements",
      "GET /api/improvements/:proposalKey",
      "POST /api/improvements/:proposalKey/approve",
      "POST /api/improvements/:proposalKey/reject",
      "POST /api/improvements/:proposalKey/pause",
      "GET /api/hands",
      "GET /api/hands/:id",
      "POST /api/hands/:id/activate",
      "POST /api/hands/:id/pause",
      "GET /api/skills",
      "GET /api/skills/:id"
    ]
  },
  defaultRequestedProvider: {
    source: {
      path: "public/docs/setup.md",
      section: "What to expect locally",
      excerpt:
        "If Gemini key validation has succeeded, chat defaults to Gemini first, with Workers AI preserved as the fallback route when available."
    },
    value: "gemini"
  }
};

export async function runScheduledDocsDriftReview(input: {
  env: Pick<Env, "AI" | "AI_MODEL" | "GEMINI_API_KEY">;
  cron: string;
  contract?: DocsContract;
}): Promise<DocsDriftReviewResult> {
  const contract = input.contract ?? defaultDocsContract;
  const findings = evaluateDocsDrift({ env: input.env, contract });

  return {
    cron: input.cron,
    reviewedDocumentCount: countReviewedDocuments(contract),
    reviewedClaimCount: 4,
    findingCount: findings.length,
    findings,
    summary:
      findings.length > 0
        ? `Docs drift hand reviewed 4 bounded docs claims and recorded ${findings.length} reviewable finding(s).`
        : "Docs drift hand reviewed 4 bounded docs claims and found no meaningful drift."
  };
}

function evaluateDocsDrift(input: {
  env: Pick<Env, "AI" | "AI_MODEL" | "GEMINI_API_KEY">;
  contract: DocsContract;
}): DocsDriftFinding[] {
  const findings: DocsDriftFinding[] = [];
  const runtimeHands = sortValues(bundledHandDefinitions.map((hand) => hand.id));
  const runtimeSkills = sortValues(getBundledSkillCatalog().map((skill) => skill.id));
  const runtimeOperatorRoutes = sortValues([...buildBootstrapStatus().operatorRoutes]);
  const runtimeRequestedProvider = resolveModelSelection(input.env, null).requestedModel?.provider ?? "none";

  maybePushSetDriftFinding({
    findings,
    kind: "hand-posture",
    findingKey: "docs-drift:bundled-hands",
    runtimeValues: runtimeHands,
    contractClaim: input.contract.documentedHands,
    severity: "medium",
    subject: "bundled hands",
    recommendedReview:
      "Review the bundled-hand sections in public/docs/setup.md and public/docs/runtime.md so operators see the current shipped hand posture without relying on guesswork."
  });
  maybePushSetDriftFinding({
    findings,
    kind: "skill-posture",
    findingKey: "docs-drift:bundled-skills",
    runtimeValues: runtimeSkills,
    contractClaim: input.contract.documentedSkills,
    severity: "medium",
    subject: "bundled skills",
    recommendedReview:
      "Review the bundled-skill references in public/docs/setup.md and public/docs/runtime.md so the documented skill posture matches the manifest set."
  });
  maybePushSetDriftFinding({
    findings,
    kind: "operator-route",
    findingKey: "docs-drift:operator-routes",
    runtimeValues: runtimeOperatorRoutes,
    contractClaim: input.contract.documentedOperatorRoutes,
    severity: "high",
    subject: "protected operator routes",
    recommendedReview:
      "Review the operator-route table in public/docs/runtime.md and keep the protected route semantics aligned with the shipped /api surface."
  });

  if (runtimeRequestedProvider !== input.contract.defaultRequestedProvider.value) {
    findings.push({
      findingKey: "docs-drift:default-requested-provider",
      kind: "model-posture",
      severity: "medium",
      summary:
        `Docs describe ${input.contract.defaultRequestedProvider.value} as the default requested provider, ` +
        `but the runtime default resolves to ${runtimeRequestedProvider}.`,
      recommendedReview:
        "Review the model-default wording in public/docs/setup.md and public/docs/runtime.md so the documented provider posture matches the selection logic.",
      source: input.contract.defaultRequestedProvider.source,
      evidence: [
        {
          kind: "docs",
          summary: "Documented default provider claim",
          detail: input.contract.defaultRequestedProvider.source.excerpt
        },
        {
          kind: "runtime",
          summary: "Resolved runtime default provider",
          detail: `requested default provider=${runtimeRequestedProvider}`
        }
      ]
    });
  }

  return findings;
}

function maybePushSetDriftFinding(input: {
  findings: DocsDriftFinding[];
  kind: DocsDriftKind;
  findingKey: string;
  runtimeValues: string[];
  contractClaim: DocsContractSetClaim;
  severity: DocsDriftSeverity;
  subject: string;
  recommendedReview: string;
}) {
  const documentedValues = sortValues(input.contractClaim.values);
  const missingFromDocs = input.runtimeValues.filter((value) => !documentedValues.includes(value));
  const missingFromRuntime = documentedValues.filter((value) => !input.runtimeValues.includes(value));

  if (missingFromDocs.length === 0 && missingFromRuntime.length === 0) {
    return;
  }

  input.findings.push({
    findingKey: input.findingKey,
    kind: input.kind,
    severity: input.severity,
    summary: buildSetMismatchSummary({
      subject: input.subject,
      missingFromDocs,
      missingFromRuntime
    }),
    recommendedReview: input.recommendedReview,
    source: input.contractClaim.source,
    evidence: [
      {
        kind: "docs",
        summary: `Documented ${input.subject}`,
        detail: formatValues(documentedValues)
      },
      {
        kind: "runtime",
        summary: `Runtime ${input.subject}`,
        detail: formatValues(input.runtimeValues)
      }
    ]
  });
}

function buildSetMismatchSummary(input: {
  subject: string;
  missingFromDocs: string[];
  missingFromRuntime: string[];
}): string {
  const parts = [`Docs/runtime drift detected for ${input.subject}.`];

  if (input.missingFromDocs.length > 0) {
    parts.push(`Runtime includes ${formatValues(input.missingFromDocs)} that the docs do not mention.`);
  }

  if (input.missingFromRuntime.length > 0) {
    parts.push(`Docs still mention ${formatValues(input.missingFromRuntime)} that the runtime no longer ships.`);
  }

  return parts.join(" ");
}

function countReviewedDocuments(contract: DocsContract): number {
  return new Set([
    contract.documentedHands.source.path,
    contract.documentedSkills.source.path,
    contract.documentedOperatorRoutes.source.path,
    contract.defaultRequestedProvider.source.path
  ]).size;
}

function sortValues(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function formatValues(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}