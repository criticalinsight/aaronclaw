export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;

export type MessageRole = "user" | "assistant";
export type SessionEventKind = "message" | "tool-event";
type AaronDbAttribute =
  | "type"
  | "createdAt"
  | "lastActiveAt"
  | "session"
  | "role"
  | "content"
  | "toolName"
  | "summary"
  | "metadata"
  | "memoryTerm";

export interface AaronDbFactRecord {
  sessionId: string;
  entity: string;
  attribute: AaronDbAttribute;
  value: JsonValue;
  tx: number;
  txIndex: number;
  occurredAt: string;
  operation: "assert";
}

interface AaronDbFactRow {
  session_id: string;
  entity: string;
  attribute: AaronDbAttribute;
  value_json: string;
  tx: number;
  tx_index: number;
  occurred_at: string;
  operation: "assert";
}

interface BaseSessionEvent {
  id: string;
  kind: SessionEventKind;
  createdAt: string;
  tx: number;
  metadata: JsonObject | null;
  recallTerms: string[];
}

export interface MessageEvent extends BaseSessionEvent {
  kind: "message";
  role: MessageRole;
  content: string;
}

export interface ToolEvent extends BaseSessionEvent {
  kind: "tool-event";
  toolName: string;
  summary: string;
}

export type SessionEvent = MessageEvent | ToolEvent;

export interface SessionRecord {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  lastTx: number;
  persistence: "aarondb-edge";
  memorySource: "aarondb-edge";
  events: SessionEvent[];
  messages: MessageEvent[];
  toolEvents: ToolEvent[];
  recallableMemoryCount: number;
}

export interface RecallMatch {
  eventId: string;
  kind: SessionEventKind;
  tx: number;
  score: number;
  matchedTerms: string[];
  preview: string;
}

export interface SessionStateRepository {
  createSession(timestamp: string): Promise<SessionRecord>;
  getSession(options?: { asOf?: number }): Promise<SessionRecord | null>;
  appendMessage(input: {
    timestamp: string;
    role: MessageRole;
    content: string;
    metadata?: JsonObject;
  }): Promise<SessionRecord>;
  appendToolEvent(input: {
    timestamp: string;
    toolName: string;
    summary: string;
    metadata?: JsonObject;
  }): Promise<SessionRecord>;
  recall(input: {
    query: string;
    limit?: number;
    asOf?: number;
  }): Promise<RecallMatch[]>;
  syncFacts(facts: AaronDbFactRecord[]): Promise<void>;
}

type AaronDbEntityIndex = Map<AaronDbAttribute, AaronDbFactRecord[]>;
type AaronDbAttributeValueIndex = Map<string, AaronDbFactRecord[]>;

class AaronDbCompatMemoryIndex {
  private readonly eavt = new Map<string, AaronDbEntityIndex>();
  private readonly aevt = new Map<AaronDbAttribute, AaronDbFactRecord[]>();
  private readonly avet = new Map<AaronDbAttribute, AaronDbAttributeValueIndex>();
  private latestTx = 0;

  reset(facts: AaronDbFactRecord[]): void {
    this.eavt.clear();
    this.aevt.clear();
    this.avet.clear();
    this.latestTx = 0;
    this.appendMany(facts);
  }

  appendMany(facts: AaronDbFactRecord[]): void {
    for (const fact of [...facts].sort(compareFacts)) {
      this.append(fact);
    }
  }

  getLatestTx(): number {
    return this.latestTx;
  }

  getLatestValue(
    entity: string,
    attribute: AaronDbAttribute,
    asOf?: number
  ): JsonValue | undefined {
    return this.findLatestFact(this.eavt.get(entity)?.get(attribute), asOf)?.value;
  }

  getAllValues(entity: string, attribute: AaronDbAttribute, asOf?: number): JsonValue[] {
    return (this.eavt.get(entity)?.get(attribute) ?? [])
      .filter((fact) => this.isVisible(fact, asOf))
      .map((fact) => fact.value);
  }

  getEntityLastTx(entity: string, asOf?: number): number {
    const entityFacts = this.eavt.get(entity);

    if (!entityFacts) {
      return 0;
    }

    let latestTx = 0;

    for (const facts of entityFacts.values()) {
      const fact = this.findLatestFact(facts, asOf);

      if (fact) {
        latestTx = Math.max(latestTx, fact.tx);
      }
    }

    return latestTx;
  }

  findEntities(attribute: AaronDbAttribute, value: JsonValue, asOf?: number): string[] {
    const facts = this.avet.get(attribute)?.get(serializeValueKey(value)) ?? [];
    const entities = new Set<string>();

    for (const fact of facts) {
      if (this.isVisible(fact, asOf)) {
        entities.add(fact.entity);
      }
    }

    return [...entities];
  }

  findEntitiesWithAttribute(attribute: AaronDbAttribute, asOf?: number): string[] {
    const facts = this.aevt.get(attribute) ?? [];
    const entities = new Set<string>();

    for (const fact of facts) {
      if (this.isVisible(fact, asOf)) {
        entities.add(fact.entity);
      }
    }

    return [...entities];
  }

  private append(fact: AaronDbFactRecord): void {
    const entityFacts = this.eavt.get(fact.entity) ?? new Map<AaronDbAttribute, AaronDbFactRecord[]>();
    const attributeFacts = entityFacts.get(fact.attribute) ?? [];
    attributeFacts.push(fact);
    entityFacts.set(fact.attribute, attributeFacts);
    this.eavt.set(fact.entity, entityFacts);

    const factsForAttribute = this.aevt.get(fact.attribute) ?? [];
    factsForAttribute.push(fact);
    this.aevt.set(fact.attribute, factsForAttribute);

    const valuesForAttribute = this.avet.get(fact.attribute) ?? new Map<string, AaronDbFactRecord[]>();
    const valueKey = serializeValueKey(fact.value);
    const factsForValue = valuesForAttribute.get(valueKey) ?? [];
    factsForValue.push(fact);
    valuesForAttribute.set(valueKey, factsForValue);
    this.avet.set(fact.attribute, valuesForAttribute);

    this.latestTx = Math.max(this.latestTx, fact.tx);
  }

  private findLatestFact(
    facts: AaronDbFactRecord[] | undefined,
    asOf?: number
  ): AaronDbFactRecord | undefined {
    if (!facts || facts.length === 0) {
      return undefined;
    }

    if (asOf === undefined) {
      return facts[facts.length - 1];
    }

    for (let index = facts.length - 1; index >= 0; index -= 1) {
      if (facts[index].tx <= asOf) {
        return facts[index];
      }
    }

    return undefined;
  }

  private isVisible(fact: AaronDbFactRecord, asOf?: number): boolean {
    return asOf === undefined || fact.tx <= asOf;
  }
}

const FACT_SELECT_SQL = `
  SELECT session_id, entity, attribute, value_json, tx, tx_index, occurred_at, operation
  FROM aarondb_facts
  WHERE session_id = ?
  ORDER BY tx ASC, tx_index ASC
`;

const FACT_INSERT_SQL = `
  INSERT INTO aarondb_facts (
    session_id,
    entity,
    attribute,
    value_json,
    tx,
    tx_index,
    occurred_at,
    operation
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

function tokenize(content: string): string[] {
  const terms = content
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .map((token) => token.replace(/(ing|ed|es|s)$/u, ""))
    .filter((token) => token.length >= 2);

  return [...new Set(terms)];
}

function createFact(
  sessionId: string,
  entity: string,
  attribute: AaronDbAttribute,
  value: JsonValue,
  tx: number,
  txIndex: number,
  occurredAt: string
): AaronDbFactRecord {
  return {
    sessionId,
    entity,
    attribute,
    value,
    tx,
    txIndex,
    occurredAt,
    operation: "assert"
  };
}

function compareFacts(left: AaronDbFactRecord, right: AaronDbFactRecord): number {
  return left.tx - right.tx || left.txIndex - right.txIndex;
}

function serializeValueKey(value: JsonValue): string {
  return JSON.stringify(value);
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asMessageRole(value: JsonValue | undefined): MessageRole | undefined {
  return value === "user" || value === "assistant" ? value : undefined;
}

function asJsonObject(value: JsonValue | undefined): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function previewForEvent(event: SessionEvent): string {
  return event.kind === "message"
    ? event.content
    : `${event.toolName}: ${event.summary}`;
}

export class AaronDbEdgeSessionRepository implements SessionStateRepository {
  private readonly memoryIndex = new AaronDbCompatMemoryIndex();
  private hydrated = false;
  private hydratePromise: Promise<void> | null = null;
  private currentProjection: SessionRecord | null = null;

  private readonly databases: D1Database[];

  constructor(
    databaseOrDatabases: D1Database | D1Database[],
    private readonly sessionId: string
  ) {
    this.databases = Array.isArray(databaseOrDatabases) ? databaseOrDatabases : [databaseOrDatabases];
  }

  async createSession(timestamp: string): Promise<SessionRecord> {
    await this.ensureHydrated();

    if (this.currentProjection) {
      return this.currentProjection;
    }

    const tx = this.nextTx();
    const facts = [
      createFact(this.sessionId, this.sessionId, "type", "session", tx, 0, timestamp),
      createFact(
        this.sessionId,
        this.sessionId,
        "createdAt",
        timestamp,
        tx,
        1,
        timestamp
      ),
      createFact(
        this.sessionId,
        this.sessionId,
        "lastActiveAt",
        timestamp,
        tx,
        2,
        timestamp
      )
    ];

    await this.appendFacts(facts);
    return this.requireCurrentProjection();
  }

  async getSession(options?: { asOf?: number }): Promise<SessionRecord | null> {
    await this.ensureHydrated();

    if (options?.asOf !== undefined) {
      return this.project(options.asOf);
    }

    return this.currentProjection;
  }

  async appendMessage(input: {
    timestamp: string;
    role: MessageRole;
    content: string;
    metadata?: JsonObject;
  }): Promise<SessionRecord> {
    await this.ensureHydrated();
    this.assertInitialized();

    const tx = this.nextTx();
    const entity = `${this.sessionId}:message:${tx}`;
    const facts: AaronDbFactRecord[] = [
      createFact(
        this.sessionId,
        this.sessionId,
        "lastActiveAt",
        input.timestamp,
        tx,
        0,
        input.timestamp
      ),
      createFact(this.sessionId, entity, "type", "message", tx, 1, input.timestamp),
      createFact(this.sessionId, entity, "session", this.sessionId, tx, 2, input.timestamp),
      createFact(
        this.sessionId,
        entity,
        "createdAt",
        input.timestamp,
        tx,
        3,
        input.timestamp
      ),
      createFact(this.sessionId, entity, "role", input.role, tx, 4, input.timestamp),
      createFact(
        this.sessionId,
        entity,
        "content",
        input.content,
        tx,
        5,
        input.timestamp
      )
    ];

    let txIndex = 6;

    if (input.metadata && Object.keys(input.metadata).length > 0) {
      facts.push(
        createFact(
          this.sessionId,
          entity,
          "metadata",
          input.metadata,
          tx,
          txIndex,
          input.timestamp
        )
      );
      txIndex += 1;
    }

    for (const term of tokenize(input.content)) {
      facts.push(
        createFact(
          this.sessionId,
          entity,
          "memoryTerm",
          term,
          tx,
          txIndex,
          input.timestamp
        )
      );
      txIndex += 1;
    }

    await this.appendFacts(facts);
    return this.requireCurrentProjection();
  }

  async appendToolEvent(input: {
    timestamp: string;
    toolName: string;
    summary: string;
    metadata?: JsonObject;
  }): Promise<SessionRecord> {
    await this.ensureHydrated();
    this.assertInitialized();

    const tx = this.nextTx();
    const entity = `${this.sessionId}:tool:${tx}`;
    const facts: AaronDbFactRecord[] = [
      createFact(
        this.sessionId,
        this.sessionId,
        "lastActiveAt",
        input.timestamp,
        tx,
        0,
        input.timestamp
      ),
      createFact(this.sessionId, entity, "type", "tool-event", tx, 1, input.timestamp),
      createFact(this.sessionId, entity, "session", this.sessionId, tx, 2, input.timestamp),
      createFact(
        this.sessionId,
        entity,
        "createdAt",
        input.timestamp,
        tx,
        3,
        input.timestamp
      ),
      createFact(
        this.sessionId,
        entity,
        "toolName",
        input.toolName,
        tx,
        4,
        input.timestamp
      ),
      createFact(
        this.sessionId,
        entity,
        "summary",
        input.summary,
        tx,
        5,
        input.timestamp
      )
    ];

    let txIndex = 6;

    if (input.metadata && Object.keys(input.metadata).length > 0) {
      facts.push(
        createFact(
          this.sessionId,
          entity,
          "metadata",
          input.metadata,
          tx,
          txIndex,
          input.timestamp
        )
      );
      txIndex += 1;
    }

    for (const term of tokenize(`${input.toolName} ${input.summary}`)) {
      facts.push(
        createFact(
          this.sessionId,
          entity,
          "memoryTerm",
          term,
          tx,
          txIndex,
          input.timestamp
        )
      );
      txIndex += 1;
    }

    await this.appendFacts(facts);
    return this.requireCurrentProjection();
  }

  async recall(input: {
    query: string;
    limit?: number;
    asOf?: number;
  }): Promise<RecallMatch[]> {
    await this.ensureHydrated();

    if (this.memoryIndex.getLatestValue(this.sessionId, "type", input.asOf) !== "session") {
      return [];
    }

    const queryTerms = tokenize(input.query);

    if (queryTerms.length === 0) {
      return [];
    }

    const candidateEventIds = new Set<string>();

    for (const term of queryTerms) {
      for (const eventId of this.memoryIndex.findEntities("memoryTerm", term, input.asOf)) {
        candidateEventIds.add(eventId);
      }
    }

    return [...candidateEventIds]
      .map((eventId) => this.projectEvent(eventId, input.asOf))
      .filter((event): event is SessionEvent => event !== null)
      .map((event) => {
        const matchedTerms = event.recallTerms.filter((term) => queryTerms.includes(term));

        return matchedTerms.length === 0
          ? null
          : {
              eventId: event.id,
              kind: event.kind,
              tx: event.tx,
              matchedTerms,
              score: matchedTerms.length / queryTerms.length,
              preview: previewForEvent(event)
            } satisfies RecallMatch;
      })
      .filter((match): match is RecallMatch => match !== null)
      .sort((left, right) => right.score - left.score || right.tx - left.tx)
      .slice(0, input.limit ?? 5);
  }

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) {
      return;
    }

    if (!this.hydratePromise) {
      this.hydratePromise = this.hydrate();
    }

    await this.hydratePromise;
  }

  private async hydrate(): Promise<void> {
    const allFacts: AaronDbFactRecord[] = [];
    const seenTx = new Set<string>();

    const results = await Promise.all(
      this.databases.map((db) =>
        db
          .prepare(FACT_SELECT_SQL)
          .bind(this.sessionId)
          .all<AaronDbFactRow>()
      )
    );

    for (const result of results) {
      for (const row of result.results ?? []) {
        const txKey = `${row.tx}:${row.tx_index}`;
        if (seenTx.has(txKey)) {
          continue;
        }

        seenTx.add(txKey);
        allFacts.push({
          sessionId: row.session_id,
          entity: row.entity,
          attribute: row.attribute,
          value: JSON.parse(row.value_json) as JsonValue,
          tx: row.tx,
          txIndex: row.tx_index,
          occurredAt: row.occurred_at,
          operation: row.operation
        });
      }
    }

    // Sort facts by tx and txIndex to ensure correct replay order
    allFacts.sort((a, b) => a.tx - b.tx || a.txIndex - b.txIndex);

    this.memoryIndex.reset(allFacts);
    this.currentProjection = this.project();
    this.hydrated = true;
  }

  async syncFacts(facts: AaronDbFactRecord[]): Promise<void> {
    await this.appendFacts(facts);
  }

  private async appendFacts(facts: AaronDbFactRecord[]): Promise<void> {
    const primaryDb = this.databases[0];
    if (!primaryDb) {
      throw new Error("No primary database available for persistence");
    }

    await primaryDb.batch(
      facts.map((fact) =>
        primaryDb
          .prepare(FACT_INSERT_SQL)
          .bind(
            fact.sessionId,
            fact.entity,
            fact.attribute,
            JSON.stringify(fact.value),
            fact.tx,
            fact.txIndex,
            fact.occurredAt,
            fact.operation
          )
      )
    );

    this.memoryIndex.appendMany(facts);
    this.currentProjection = this.project();
  }

  private project(asOf?: number): SessionRecord | null {
    if (this.memoryIndex.getLatestValue(this.sessionId, "type", asOf) !== "session") {
      return null;
    }

    const createdAt = asString(this.memoryIndex.getLatestValue(this.sessionId, "createdAt", asOf)) ?? "";
    const lastActiveAt =
      asString(this.memoryIndex.getLatestValue(this.sessionId, "lastActiveAt", asOf)) ?? createdAt;
    const events = this.memoryIndex
      .findEntities("session", this.sessionId, asOf)
      .map((entity) => this.projectEvent(entity, asOf))
      .filter((event): event is SessionEvent => event !== null)
      .sort((left, right) => left.tx - right.tx);

    const messages = events.filter(
      (event): event is MessageEvent => event.kind === "message"
    );
    const toolEvents = events.filter(
      (event): event is ToolEvent => event.kind === "tool-event"
    );

    return {
      id: this.sessionId,
      createdAt,
      lastActiveAt,
      lastTx: this.memoryIndex.getEntityLastTx(this.sessionId, asOf),
      persistence: "aarondb-edge",
      memorySource: "aarondb-edge",
      events,
      messages,
      toolEvents,
      recallableMemoryCount: this.memoryIndex.findEntitiesWithAttribute("memoryTerm", asOf).length
    };
  }

  private projectEvent(entity: string, asOf?: number): SessionEvent | null {
    const kind = this.memoryIndex.getLatestValue(entity, "type", asOf);
    const createdAt = asString(this.memoryIndex.getLatestValue(entity, "createdAt", asOf));
    const metadata = asJsonObject(this.memoryIndex.getLatestValue(entity, "metadata", asOf));
    const recallTerms = [
      ...new Set(
        this.memoryIndex
          .getAllValues(entity, "memoryTerm", asOf)
          .filter((value): value is string => typeof value === "string")
      )
    ].sort();
    const tx = this.memoryIndex.getEntityLastTx(entity, asOf);

    if (kind === "message") {
      const role = asMessageRole(this.memoryIndex.getLatestValue(entity, "role", asOf));
      const content = asString(this.memoryIndex.getLatestValue(entity, "content", asOf));

      if (createdAt && role && content) {
        return {
          id: entity,
          kind,
          createdAt,
          tx,
          role,
          content,
          metadata,
          recallTerms
        };
      }

      return null;
    }

    if (kind === "tool-event") {
      const toolName = asString(this.memoryIndex.getLatestValue(entity, "toolName", asOf));
      const summary = asString(this.memoryIndex.getLatestValue(entity, "summary", asOf));

      if (createdAt && toolName && summary) {
        return {
          id: entity,
          kind,
          createdAt,
          tx,
          toolName,
          summary,
          metadata,
          recallTerms
        };
      }
    }

    return null;
  }

  private nextTx(): number {
    return this.memoryIndex.getLatestTx() + 1;
  }

  private requireCurrentProjection(): SessionRecord {
    const session = this.currentProjection;

    if (!session) {
      throw new Error("session not initialized");
    }

    return session;
  }

  private assertInitialized(): void {
    if (!this.currentProjection) {
      throw new Error("session not initialized");
    }
  }
}