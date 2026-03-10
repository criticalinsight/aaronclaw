import {
  compareAaronDbEdgeVectors,
  fingerprintAaronDbEdgeValue
} from "./aarondb-edge-substrate";
import type { JsonValue, SessionEventKind } from "./session-state";

const KNOWLEDGE_VAULT_NAMESPACE = "aaronclaw-knowledge-vault";
const KNOWLEDGE_VAULT_VECTOR_DIMENSIONS = 24;
const DEFAULT_VAULT_MATCH_LIMIT = 3;
const NOISY_TERMS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "how",
  "into",
  "that",
  "the",
  "this",
  "with"
]);
const SEMANTIC_EXPANSIONS: Record<string, string[]> = {
  aarondb: ["memory", "facts", "session"],
  context: ["memory", "history", "recall"],
  d1: ["database", "facts", "storage"],
  facts: ["memory", "history", "replay"],
  history: ["prior", "recall", "vault"],
  knowledge: ["memory", "vault", "recall"],
  recall: ["retrieve", "remember", "search"],
  session: ["conversation", "history", "state"],
  vector: ["embedding", "vectorize", "semantic"],
  vectorize: ["vector", "embedding", "semantic"],
  vault: ["knowledge", "history", "recall"]
};

const HISTORICAL_FACT_SELECT_SQL = `
  SELECT session_id, entity, attribute, value_json, tx, tx_index, occurred_at, operation
  FROM aarondb_facts
  WHERE session_id != ?
  ORDER BY session_id ASC, tx ASC, tx_index ASC
`;

type HistoricalFactAttribute =
  | "type"
  | "createdAt"
  | "role"
  | "content"
  | "toolName"
  | "summary"
  | "session";

interface HistoricalFactRow {
  session_id: string;
  entity: string;
  attribute: HistoricalFactAttribute | string;
  value_json: string;
  tx: number;
  tx_index: number;
  occurred_at: string;
  operation: "assert";
}

interface HistoricalEventDocument {
  sessionId: string;
  eventId: string;
  kind: SessionEventKind;
  tx: number;
  createdAt: string;
  preview: string;
}

type MutableHistoricalEventDocument = Partial<HistoricalEventDocument> & {
  eventId: string;
  sessionId: string;
  content?: string;
  summary?: string;
  toolName?: string;
};

export interface KnowledgeVaultMatch {
  sessionId: string;
  eventId: string;
  kind: SessionEventKind;
  tx: number;
  createdAt: string;
  preview: string;
  score: number;
  source: "vectorize" | "d1-compat";
}

export interface KnowledgeVaultResult {
  matches: KnowledgeVaultMatch[];
  source: "vectorize" | "d1-compat";
}

export async function queryKnowledgeVault(input: {
  env: Pick<Env, "AARONDB"> & Partial<Pick<Env, "VECTOR_INDEX">>;
  sessionId: string;
  query: string;
  limit?: number;
}): Promise<KnowledgeVaultResult> {
  const limit = input.limit ?? DEFAULT_VAULT_MATCH_LIMIT;
  const queryTerms = expandSemanticTerms(input.query);

  if (queryTerms.length === 0) {
    return { matches: [], source: input.env.VECTOR_INDEX ? "vectorize" : "d1-compat" };
  }

  const documents = await loadHistoricalEventDocuments(input.env.AARONDB, input.sessionId);
  if (documents.length === 0) {
    return { matches: [], source: input.env.VECTOR_INDEX ? "vectorize" : "d1-compat" };
  }

  const queryVector = buildSemanticVector(queryTerms);
  const vectorizeMatches = await queryVectorizeMatches(
    input.env.VECTOR_INDEX,
    documents,
    queryVector,
    limit
  );

  if (vectorizeMatches.length > 0) {
    return { matches: vectorizeMatches, source: "vectorize" };
  }

  return {
    matches: rankDocuments(documents, queryTerms, queryVector, limit).map((match) => ({
      ...match,
      source: "d1-compat"
    })),
    source: "d1-compat"
  };
}

async function loadHistoricalEventDocuments(
  database: D1Database,
  currentSessionId: string
): Promise<HistoricalEventDocument[]> {
  const result = await database
    .prepare(HISTORICAL_FACT_SELECT_SQL)
    .bind(currentSessionId)
    .all<HistoricalFactRow>();

  const documents = new Map<string, MutableHistoricalEventDocument>();

  for (const row of result.results ?? []) {
    const value = parseJson(row.value_json);
    const key = `${row.session_id}:${row.entity}`;
    const document = documents.get(key) ?? {
      eventId: row.entity,
      sessionId: row.session_id,
      tx: row.tx,
      createdAt: row.occurred_at
    };

    document.tx = Math.max(document.tx ?? 0, row.tx);
    document.createdAt = document.createdAt ?? row.occurred_at;

    if (row.attribute === "type" && (value === "message" || value === "tool-event")) {
      document.kind = value;
    }

    if (row.attribute === "createdAt" && typeof value === "string") {
      document.createdAt = value;
    }

    if (row.attribute === "content" && typeof value === "string") {
      document.content = value;
    }

    if (row.attribute === "summary" && typeof value === "string") {
      document.summary = value;
    }

    if (row.attribute === "toolName" && typeof value === "string") {
      document.toolName = value;
    }

    documents.set(key, document);
  }

  return [...documents.values()]
    .map(finalizeHistoricalEventDocument)
    .filter((document): document is HistoricalEventDocument => document !== null)
    .sort(compareDocumentsByRecency);
}

function finalizeHistoricalEventDocument(
  document: MutableHistoricalEventDocument
): HistoricalEventDocument | null {
  if (document.kind === "message" && document.content) {
    return {
      sessionId: document.sessionId,
      eventId: document.eventId,
      kind: document.kind,
      tx: document.tx ?? 0,
      createdAt: document.createdAt ?? "",
      preview: document.content
    };
  }

  if (document.kind === "tool-event" && document.toolName && document.summary) {
    return {
      sessionId: document.sessionId,
      eventId: document.eventId,
      kind: document.kind,
      tx: document.tx ?? 0,
      createdAt: document.createdAt ?? "",
      preview: `${document.toolName}: ${document.summary}`
    };
  }

  return null;
}

async function queryVectorizeMatches(
  index: VectorizeIndex | undefined,
  documents: HistoricalEventDocument[],
  queryVector: number[],
  limit: number
): Promise<KnowledgeVaultMatch[]> {
  if (!index || documents.length === 0) {
    return [];
  }

  try {
    await index.upsert(
      documents.map((document) => ({
        id: `${document.sessionId}:${document.eventId}`,
        namespace: KNOWLEDGE_VAULT_NAMESPACE,
        values: buildSemanticVector(expandSemanticTerms(document.preview)),
        metadata: {
          sessionId: document.sessionId,
          eventId: document.eventId,
          kind: document.kind,
          tx: document.tx,
          createdAt: document.createdAt,
          preview: trimText(document.preview, 240)
        }
      }))
    );

    const result = await index.query(queryVector, {
      topK: limit,
      namespace: KNOWLEDGE_VAULT_NAMESPACE,
      returnMetadata: "all"
    });

    return (result.matches ?? [])
      .map((match) => normalizeVectorizeMatch(match))
      .filter((match): match is KnowledgeVaultMatch => match !== null)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function normalizeVectorizeMatch(match: VectorizeMatch): KnowledgeVaultMatch | null {
  const metadata = match.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const sessionId = typeof metadata.sessionId === "string" ? metadata.sessionId : null;
  const eventId = typeof metadata.eventId === "string" ? metadata.eventId : null;
  const kind = metadata.kind === "message" || metadata.kind === "tool-event" ? metadata.kind : null;
  const createdAt = typeof metadata.createdAt === "string" ? metadata.createdAt : "";
  const preview = typeof metadata.preview === "string" ? metadata.preview : "";
  const tx = typeof metadata.tx === "number" ? metadata.tx : 0;

  if (!sessionId || !eventId || !kind || !preview) {
    return null;
  }

  return {
    sessionId,
    eventId,
    kind,
    tx,
    createdAt,
    preview,
    score: roundScore(match.score),
    source: "vectorize"
  };
}

function rankDocuments(
  documents: HistoricalEventDocument[],
  queryTerms: string[],
  queryVector: number[],
  limit: number
): Omit<KnowledgeVaultMatch, "source">[] {
  return documents
    .map((document) => {
      const documentTerms = expandSemanticTerms(document.preview);
      const overlap = scoreTermOverlap(queryTerms, documentTerms);
      const vectorScore = safeVectorScore(queryVector, buildSemanticVector(documentTerms));
      const score = roundScore(overlap * 0.55 + vectorScore * 0.45);

      return {
        sessionId: document.sessionId,
        eventId: document.eventId,
        kind: document.kind,
        tx: document.tx,
        createdAt: document.createdAt,
        preview: document.preview,
        score
      };
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || compareDocumentsByRecency(left, right))
    .slice(0, limit);
}

function expandSemanticTerms(value: string): string[] {
  const expanded = new Set<string>();

  for (const term of tokenize(value)) {
    if (NOISY_TERMS.has(term)) {
      continue;
    }

    expanded.add(term);

    for (const synonym of SEMANTIC_EXPANSIONS[term] ?? []) {
      expanded.add(synonym);
    }
  }

  return [...expanded];
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length > 1);
}

function buildSemanticVector(terms: string[]): number[] {
  const vector = Array.from({ length: KNOWLEDGE_VAULT_VECTOR_DIMENSIONS }, () => 0);

  for (const term of terms) {
    addVectorWeight(vector, term, 1);
  }

  return vector;
}

function addVectorWeight(vector: number[], value: string, weight: number): void {
  const primarySlot = Math.abs(fingerprintAaronDbEdgeValue(value)) % vector.length;
  const secondarySlot = Math.abs(fingerprintAaronDbEdgeValue(`${value}:alt`)) % vector.length;

  vector[primarySlot] += weight;
  vector[secondarySlot] += weight / 2;
}

function scoreTermOverlap(queryTerms: string[], documentTerms: string[]): number {
  const querySet = new Set(queryTerms);
  if (querySet.size === 0) {
    return 0;
  }

  const documentSet = new Set(documentTerms);
  let overlap = 0;

  for (const term of querySet) {
    if (documentSet.has(term)) {
      overlap += 1;
    }
  }

  return overlap / querySet.size;
}

function safeVectorScore(left: number[], right: number[]): number {
  const raw = compareAaronDbEdgeVectors(left, right);
  return Number.isFinite(raw) ? Math.max(0, raw) : 0;
}

function compareDocumentsByRecency(
  left: Pick<HistoricalEventDocument, "createdAt" | "tx">,
  right: Pick<HistoricalEventDocument, "createdAt" | "tx">
): number {
  return right.createdAt.localeCompare(left.createdAt) || right.tx - left.tx;
}

function parseJson(value: string): JsonValue | null {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return null;
  }
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function trimText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}