import {
  compareAaronDbEdgeVectors,
  fingerprintAaronDbEdgeValue
} from "./aarondb-edge-substrate";
import type { JsonValue, SessionEventKind } from "./session-state";

const KNOWLEDGE_VAULT_NAMESPACE = "aaronclaw-knowledge-vault-v2";
const KNOWLEDGE_VAULT_MODEL = "@cf/baai/bge-m3";
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

const SEMANTIC_ONTOLOGY_SELECT_SQL = `
  SELECT expansions
  FROM semantic_ontology
  WHERE term = ?
`;

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
  source: "vectorize" | "d1-compat" | "skill-disabled";
}

export interface KnowledgeVaultResult {
  matches: KnowledgeVaultMatch[];
  source: "vectorize" | "d1-compat" | "skill-disabled";
}

export async function queryKnowledgeVault(input: {
  env: Pick<Env, "AARONDB" | "AI"> & Partial<Pick<Env, "VECTOR_INDEX">>;
  sessionId: string;
  query: string;
  limit?: number;
}): Promise<KnowledgeVaultResult> {
  const limit = input.limit ?? DEFAULT_VAULT_MATCH_LIMIT;
  const queryTerms = await expandSemanticTerms(input.env, input.query);

  if (queryTerms.length === 0) {
    return { matches: [], source: input.env.VECTOR_INDEX ? "vectorize" : "d1-compat" };
  }

  const documents = await loadHistoricalEventDocuments(input.env.AARONDB, input.sessionId);
  if (documents.length === 0) {
    return { matches: [], source: input.env.VECTOR_INDEX ? "vectorize" : "d1-compat" };
  }

  const queryVector = await buildSemanticVector(input.env.AI, queryTerms.join(" "));
  const vectorizeMatches = await queryVectorizeMatches(
    input.env.AI,
    input.env.VECTOR_INDEX,
    documents,
    queryVector,
    limit
  );

  if (vectorizeMatches.length > 0) {
    return { matches: vectorizeMatches, source: "vectorize" };
  }

  return {
    matches: (
      await rankDocuments(input.env.AI, input.env.AARONDB, documents, queryTerms, queryVector, limit)
    ).map((match) => ({
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
  ai: WorkersAiBinding,
  index: VectorizeIndex | undefined,
  documents: HistoricalEventDocument[],
  queryVector: number[],
  limit: number
): Promise<KnowledgeVaultMatch[]> {
  if (!index || documents.length === 0) {
    return [];
  }

  try {
    const upserts = await Promise.all(
      documents.map(async (document) => ({
        id: `${document.sessionId}:${document.eventId}`,
        namespace: KNOWLEDGE_VAULT_NAMESPACE,
        values: await buildSemanticVector(ai, document.preview),
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

    await index.upsert(upserts);

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

async function rankDocuments(
  ai: WorkersAiBinding,
  database: D1Database,
  documents: HistoricalEventDocument[],
  queryTerms: string[],
  queryVector: number[],
  limit: number
): Promise<Omit<KnowledgeVaultMatch, "source">[]> {
  const ranked = await Promise.all(
    documents.map(async (document) => {
      const documentTerms = await expandSemanticTerms({ AI: ai, AARONDB: database }, document.preview);
      const overlap = scoreTermOverlap(queryTerms, documentTerms);
      const documentVector = await buildSemanticVector(ai, document.preview);
      const vectorScore = safeVectorScore(queryVector, documentVector);
      const score = roundScore(overlap * 0.4 + vectorScore * 0.6); // Weight shifted towards vector precision

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
  );

  return ranked
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || compareDocumentsByRecency(left, right))
    .slice(0, limit);
}

export async function expandSemanticTerms(
  env: Pick<Env, "AI" | "AARONDB"> & { VECTOR_INDEX?: VectorizeIndex },
  value: string
): Promise<string[]> {
  const expanded = new Set<string>();
  const tokens = tokenize(value);
  const ai = env.AI;
  const db = env.AARONDB;
  const index = env.VECTOR_INDEX;

  for (const term of tokens) {
    if (NOISY_TERMS.has(term)) {
      continue;
    }

    expanded.add(term);

    // 🧙🏾‍♂️ Rich Hickey: Vector-based dynamic ontology lookup.
    // De-complecting exact matches from semantic intent.
    try {
      const termVector = await buildSemanticVector(ai, term, "@cf/baai/bge-small-en-v1.5");
      
      // Attempt vector search in ontology namespace if available
      const matches = await index?.query(termVector, {
        topK: 5,
        namespace: "ontology",
        returnMetadata: "all"
      });

      if (matches?.matches && matches.matches.length > 0) {
        for (const match of matches.matches) {
          const expansions = JSON.parse((match.metadata?.expansions as string) || "[]");
          for (const e of expansions) {
            expanded.add(e);
          }
        }
      } else {
        // Fallback to exact match in D1
        const result = await db
          .prepare(SEMANTIC_ONTOLOGY_SELECT_SQL)
          .bind(term)
          .first<{ expansions: string }>();

        if (result?.expansions) {
          const synonyms = JSON.parse(result.expansions) as string[];
          for (const synonym of synonyms) {
            expanded.add(synonym);
          }
        }
      }
    } catch (e) {
      console.warn(`Semantic Expansion: Dynamic lookup failed for ${term}`, e);
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

export async function buildSemanticVector(
  ai: WorkersAiBinding | undefined | null,
  text: string,
  model: string = KNOWLEDGE_VAULT_MODEL
): Promise<number[]> {
  try {
    if (!ai || typeof ai.run !== "function") {
      throw new Error(`Workers AI is not available (model: ${model})`);
    }
    const response = await ai.run(model, {
      text: [text]
    });
    return response.data[0];
  } catch (error) {
    console.error(`KnowledgeVault: Embedding error (${model})`, error);
    // Return zero vector of appropriate size as fallback
    const dims = model === "@cf/baai/bge-small-en-v1.5" ? 384 : 1024;
    return Array.from({ length: dims }, () => 0);
  }
}

function addVectorWeight(vector: number[], value: string, weight: number): void {
  const primarySlot = Math.abs(fingerprintAaronDbEdgeValue(value)) % vector.length;
  const secondarySlot = Math.abs(fingerprintAaronDbEdgeValue(`${value}:alt`)) % vector.length;

  vector[primarySlot] += weight;
  vector[secondarySlot] += weight / 2;
}

export function scoreTermOverlap(queryTerms: string[], documentTerms: string[]): number {
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

export function safeVectorScore(left: number[], right: number[]): number {
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

export function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function trimText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}