export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;

export type MessageRole = "user" | "assistant" | "tool";
export type SessionEventKind = "message" | "tool-event";
type AaronDbAttribute =
  | "type"
  | "createdAt"
  | "occurredAt"
  | "lastActiveAt"
  | "session"
  | "role"
  | "content"
  | "toolName"
  | "summary"
  | "metadata"
  | "memoryTerm"
  | "toolCalls"
  | "toolCallId"
  // Managed Project Attributes
  | "repoUrl"
  | "repoBranch"
  | "optimizationTarget"
  // Pulse Telemetry Attributes
  | "metricKind"
  | "metricValue"
  // Panopticon Attributes
  | "externalState"
  // MeshSignal Attributes
  | "signalKind"
  | "signalPayload"
  | "signalTarget"
  // KnowledgeNexus Attributes
  | "patternSummary"
  | "patternContext"
  | "patternDistillationTx";

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
  toolCalls?: any[];
  toolCallId?: string;
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
    toolCalls?: any[];
    toolCallId?: string;
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
  assertSignal(input: { kind: string; payload: JsonValue; target?: string }): Promise<void>;
  querySignals(options?: { kind?: string; target?: string; asOf?: number }): Promise<MeshSignal[]>;
  assertPattern(input: { summary: string; context: JsonObject; distillationTx: number }): Promise<void>;
  queryPatterns(options?: { asOf?: number }): Promise<KnowledgePattern[]>;
}

export interface KnowledgePattern {
  summary: string;
  context: JsonObject;
  distillationTx: number;
  occurredAt: string;
}

export interface MeshSignal {
  kind: string;
  payload: JsonValue;
  target?: string;
  occurredAt: string;
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
    if (!entityFacts) return 0;

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
    if (!facts || facts.length === 0) return undefined;
    if (asOf === undefined) return facts[facts.length - 1];

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

// --- Pure Data Transformation Functions ---

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
  return value === "user" || value === "assistant" || value === "tool" ? value : undefined;
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

function parseFactRow(row: AaronDbFactRow): AaronDbFactRecord {
  return {
    sessionId: row.session_id,
    entity: row.entity,
    attribute: row.attribute,
    value: JSON.parse(row.value_json),
    tx: row.tx,
    txIndex: row.tx_index,
    occurredAt: row.occurred_at,
    operation: row.operation,
  };
}

function mergeAndSortFactRows(results: D1Result<AaronDbFactRow>[]): AaronDbFactRecord[] {
  const allFacts: AaronDbFactRecord[] = [];
  const seenTx = new Set<string>();

  for (const result of results) {
    for (const row of result.results ?? []) {
      const txKey = `${row.tx}:${row.tx_index}`;
      if (!seenTx.has(txKey)) {
        seenTx.add(txKey);
        allFacts.push(parseFactRow(row));
      }
    }
  }
  return allFacts.sort(compareFacts);
}

function createSessionFacts(sessionId: string, timestamp: string, tx: number): AaronDbFactRecord[] {
  const factData = [
    { entity: sessionId, attribute: "type", value: "session" },
    { entity: sessionId, attribute: "createdAt", value: timestamp },
    { entity: sessionId, attribute: "lastActiveAt", value: timestamp },
  ];
  return factData.map((data, index) => ({
    sessionId,
    entity: data.entity,
    attribute: data.attribute as AaronDbAttribute,
    value: data.value as JsonValue,
    tx,
    txIndex: index,
    occurredAt: timestamp,
    operation: "assert",
  }));
}

function createMessageFacts(
  sessionId: string,
  tx: number,
  input: Parameters<SessionStateRepository["appendMessage"]>[0]
): AaronDbFactRecord[] {
  const entity = `${sessionId}:message:${tx}`;
  const { timestamp, role, content, metadata, toolCalls, toolCallId } = input;

  const factData: { entity: string; attribute: AaronDbAttribute; value: JsonValue }[] = [
    { entity: sessionId, attribute: "lastActiveAt", value: timestamp },
    { entity, attribute: "type", value: "message" },
    { entity, attribute: "session", value: sessionId },
    { entity, attribute: "createdAt", value: timestamp },
    { entity, attribute: "role", value: role },
    { entity, attribute: "content", value: content },
  ];

  if (toolCalls && toolCalls.length > 0) {
    factData.push({ entity, attribute: "toolCalls", value: toolCalls });
  }
  if (toolCallId) {
    factData.push({ entity, attribute: "toolCallId", value: toolCallId });
  }
  if (metadata && Object.keys(metadata).length > 0) {
    factData.push({ entity, attribute: "metadata", value: metadata });
  }

  const memoryTerms = tokenize(content).map((term) => ({
    entity,
    attribute: "memoryTerm" as AaronDbAttribute,
    value: term as JsonValue,
  }));

  return [...factData, ...memoryTerms].map((data, index) => ({
    sessionId,
    entity: data.entity,
    attribute: data.attribute,
    value: data.value,
    tx,
    txIndex: index,
    occurredAt: timestamp,
    operation: "assert",
  }));
}

function createToolEventFacts(
  sessionId: string,
  tx: number,
  input: Parameters<SessionStateRepository["appendToolEvent"]>[0]
): AaronDbFactRecord[] {
  const entity = `${sessionId}:tool-event:${tx}`;
  const { timestamp, toolName, summary, metadata } = input;

  const factData: { entity: string; attribute: AaronDbAttribute; value: JsonValue }[] = [
    { entity: sessionId, attribute: "lastActiveAt", value: timestamp },
    { entity, attribute: "type", value: "tool-event" },
    { entity, attribute: "session", value: sessionId },
    { entity, attribute: "createdAt", value: timestamp },
    { entity, attribute: "toolName", value: toolName },
    { entity, attribute: "summary", value: summary },
  ];

  if (metadata && Object.keys(metadata).length > 0) {
    factData.push({ entity, attribute: "metadata", value: metadata });
  }

  const memoryTerms = tokenize(`${toolName} ${summary}`).map((term) => ({
    entity,
    attribute: "memoryTerm" as AaronDbAttribute,
    value: term as JsonValue,
  }));

  return [...factData, ...memoryTerms].map((data, index) => ({
    sessionId,
    entity: data.entity,
    attribute: data.attribute,
    value: data.value,
    tx,
    txIndex: index,
    occurredAt: timestamp,
    operation: "assert",
  }));
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
    await this._ensureHydrated();
    if (this.currentProjection) return this.currentProjection;

    const tx = this._nextTx();
    const facts = createSessionFacts(this.sessionId, timestamp, tx);
    await this._appendAndApplyFacts(facts);
    return this._getOrThrowCurrentProjection();
  }

  async getSession(options?: { asOf?: number }): Promise<SessionRecord | null> {
    await this._ensureHydrated();
    return options?.asOf !== undefined ? this._project(options.asOf) : this.currentProjection;
  }

  async appendMessage(input: Parameters<SessionStateRepository["appendMessage"]>[0]): Promise<SessionRecord> {
    await this._ensureHydrated();
    this._assertInitialized();

    const tx = this._nextTx();
    const facts = createMessageFacts(this.sessionId, tx, input);
    await this._appendAndApplyFacts(facts);
    return this._getOrThrowCurrentProjection();
  }

  async appendToolEvent(input: Parameters<SessionStateRepository["appendToolEvent"]>[0]): Promise<SessionRecord> {
    await this._ensureHydrated();
    this._assertInitialized();

    const tx = this._nextTx();
    const facts = createToolEventFacts(this.sessionId, tx, input);
    await this._appendAndApplyFacts(facts);
    return this._getOrThrowCurrentProjection();
  }

  async recall(input: { query: string; limit?: number; asOf?: number }): Promise<RecallMatch[]> {
    await this._ensureHydrated();
    if (this.memoryIndex.getLatestValue(this.sessionId, "type", input.asOf) !== "session") return [];

    const queryTerms = tokenize(input.query);
    if (queryTerms.length === 0) return [];

    const candidateEventIds = new Set<string>();
    for (const term of queryTerms) {
      for (const eventId of this.memoryIndex.findEntities("memoryTerm", term, input.asOf)) {
        candidateEventIds.add(eventId);
      }
    }

    return [...candidateEventIds]
      .map((eventId) => this._projectEvent(eventId, input.asOf))
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
              preview: previewForEvent(event),
            };
      })
      .filter((match): match is RecallMatch => match !== null)
      .sort((left, right) => right.score - left.score || right.tx - left.tx)
      .slice(0, input.limit ?? 5);
  }

  async syncFacts(facts: AaronDbFactRecord[]): Promise<void> {
    await this._appendAndApplyFacts(facts);
  }

  async assertSignal(input: { kind: string; payload: JsonValue; target?: string }): Promise<void> {
    await this._ensureHydrated();
    this._assertInitialized();

    const tx = this._nextTx();
    const timestamp = new Date().toISOString();
    const entity = `signal:${input.kind}:${tx}`;

    const factData: { entity: string; attribute: AaronDbAttribute; value: JsonValue }[] = [
      { entity, attribute: "type", value: "signal" },
      { entity, attribute: "signalKind", value: input.kind },
      { entity, attribute: "signalPayload", value: input.payload },
      { entity, attribute: "occurredAt", value: timestamp },
    ];

    if (input.target) {
      factData.push({ entity, attribute: "signalTarget", value: input.target });
    }

    const facts = factData.map((data, index) => ({
      sessionId: this.sessionId,
      entity: data.entity,
      attribute: data.attribute,
      value: data.value,
      tx,
      txIndex: index,
      occurredAt: timestamp,
      operation: "assert" as const,
    }));

    await this._appendAndApplyFacts(facts);
  }

  async querySignals(options?: { kind?: string; target?: string; asOf?: number }): Promise<MeshSignal[]> {
    await this._ensureHydrated();
    
    // Find all entities of type "signal"
    const signalEntities = this.memoryIndex.findEntities("type", "signal", options?.asOf);
    const results: MeshSignal[] = [];

    for (const entity of signalEntities) {
      const kind = asString(this.memoryIndex.getLatestValue(entity, "signalKind", options?.asOf));
      const payload = this.memoryIndex.getLatestValue(entity, "signalPayload", options?.asOf);
      const target = asString(this.memoryIndex.getLatestValue(entity, "signalTarget", options?.asOf));
      const occurredAt = asString(this.memoryIndex.getLatestValue(entity, "occurredAt", options?.asOf)) ?? "";

      if (!kind || !payload) continue;

      let match = true;
      if (options?.kind && kind !== options.kind) match = false;
      if (options?.target && target !== options.target) match = false;

      if (match) {
        results.push({
          kind,
          payload,
          target,
          occurredAt
        });
      }
    }

    return results;
  }

  async assertPattern(input: { summary: string; context: JsonObject; distillationTx: number }): Promise<void> {
    await this._ensureHydrated();
    this._assertInitialized();

    const tx = this._nextTx();
    const timestamp = new Date().toISOString();
    const entity = `pattern:${tx}`;

    const factData: { entity: string; attribute: AaronDbAttribute; value: JsonValue }[] = [
      { entity, attribute: "type", value: "pattern" },
      { entity, attribute: "patternSummary", value: input.summary },
      { entity, attribute: "patternContext", value: input.context },
      { entity, attribute: "patternDistillationTx", value: input.distillationTx },
      { entity, attribute: "occurredAt", value: timestamp },
    ];

    const facts = factData.map((data, index) => ({
      sessionId: this.sessionId,
      entity: data.entity,
      attribute: data.attribute,
      value: data.value,
      tx,
      txIndex: index,
      occurredAt: timestamp,
      operation: "assert" as const,
    }));

    await this._appendAndApplyFacts(facts);
  }

  async queryPatterns(options?: { asOf?: number }): Promise<KnowledgePattern[]> {
    await this._ensureHydrated();
    
    const patternEntities = this.memoryIndex.findEntities("type", "pattern", options?.asOf);
    const results: KnowledgePattern[] = [];

    for (const entity of patternEntities) {
      const summary = asString(this.memoryIndex.getLatestValue(entity, "patternSummary", options?.asOf));
      const context = asJsonObject(this.memoryIndex.getLatestValue(entity, "patternContext", options?.asOf));
      const distillationTx = this.memoryIndex.getLatestValue(entity, "patternDistillationTx", options?.asOf) as number;
      const occurredAt = asString(this.memoryIndex.getLatestValue(entity, "occurredAt", options?.asOf)) ?? "";

      if (!summary || !context) continue;

      results.push({
        summary,
        context,
        distillationTx,
        occurredAt
      });
    }

    return results;
  }

  private _ensureHydrated(): Promise<void> {
    if (this.hydrated) return Promise.resolve();
    if (!this.hydratePromise) this.hydratePromise = this._hydrate();
    return this.hydratePromise;
  }

  private async _hydrate(): Promise<void> {
    const results = await Promise.all(
      this.databases.map((db) => db.prepare(FACT_SELECT_SQL).bind(this.sessionId).all<AaronDbFactRow>())
    );
    const sortedFacts = mergeAndSortFactRows(results);
    this.memoryIndex.reset(sortedFacts);
    this.currentProjection = this._project();
    this.hydrated = true;
  }

  private async _appendAndApplyFacts(facts: AaronDbFactRecord[]): Promise<void> {
    await this._persistFacts(facts);
    this._applyFactsToMemory(facts);
  }

  private async _persistFacts(facts: AaronDbFactRecord[]): Promise<void> {
    const primaryDb = this.databases[0];
    if (!primaryDb) throw new Error("No primary database available for persistence");

    const statements = facts.map((fact) =>
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
    );
    await primaryDb.batch(statements);
  }

  private _applyFactsToMemory(facts: AaronDbFactRecord[]): void {
    this.memoryIndex.appendMany(facts);
    this.currentProjection = this._project();
  }

  private _project(asOf?: number): SessionRecord | null {
    if (this.memoryIndex.getLatestValue(this.sessionId, "type", asOf) !== "session") return null;

    const createdAt = asString(this.memoryIndex.getLatestValue(this.sessionId, "createdAt", asOf)) ?? "";
    const lastActiveAt = asString(this.memoryIndex.getLatestValue(this.sessionId, "lastActiveAt", asOf)) ?? createdAt;
    const events = this.memoryIndex
      .findEntities("session", this.sessionId, asOf)
      .map((entity) => this._projectEvent(entity, asOf))
      .filter((event): event is SessionEvent => event !== null)
      .sort((left, right) => left.tx - right.tx);

    return {
      id: this.sessionId,
      createdAt,
      lastActiveAt,
      lastTx: this.memoryIndex.getEntityLastTx(this.sessionId, asOf),
      persistence: "aarondb-edge",
      memorySource: "aarondb-edge",
      events,
      messages: events.filter((e): e is MessageEvent => e.kind === "message"),
      toolEvents: events.filter((e): e is ToolEvent => e.kind === "tool-event"),
      recallableMemoryCount: this.memoryIndex.findEntitiesWithAttribute("memoryTerm", asOf).length,
    };
  }

  private readonly eventProjectors: Record<string, (e: string, a?: number) => SessionEvent | null> = {
    message: (e, a) => this._projectMessageEvent(e, a),
    "tool-event": (e, a) => this._projectToolEvent(e, a),
  };

  private _projectEvent(entity: string, asOf?: number): SessionEvent | null {
    const kind = this.memoryIndex.getLatestValue(entity, "type", asOf) as string;
    const projector = this.eventProjectors[kind];
    return projector ? projector(entity, asOf) : null;
  }

  private _projectBaseEvent(entity: string, asOf?: number): Omit<BaseSessionEvent, "kind"> | null {
    const createdAt = asString(this.memoryIndex.getLatestValue(entity, "createdAt", asOf));
    if (!createdAt) return null;

    return {
      id: entity,
      createdAt,
      tx: this.memoryIndex.getEntityLastTx(entity, asOf),
      metadata: asJsonObject(this.memoryIndex.getLatestValue(entity, "metadata", asOf)),
      recallTerms: [
        ...new Set(
          this.memoryIndex
            .getAllValues(entity, "memoryTerm", asOf)
            .filter((v): v is string => typeof v === "string")
        ),
      ].sort(),
    };
  }

  private _projectMessageEvent(entity: string, asOf?: number): MessageEvent | null {
    const base = this._projectBaseEvent(entity, asOf);
    const role = asMessageRole(this.memoryIndex.getLatestValue(entity, "role", asOf));
    const content = asString(this.memoryIndex.getLatestValue(entity, "content", asOf));
    const toolCalls = this.memoryIndex.getLatestValue(entity, "toolCalls", asOf) as any[] | undefined;

    if (!base || !role || (content === undefined && toolCalls === undefined)) return null;

    return {
      ...base,
      kind: "message",
      role,
      content: content ?? "",
      toolCalls,
      toolCallId: asString(this.memoryIndex.getLatestValue(entity, "toolCallId", asOf)),
    };
  }

  private _projectToolEvent(entity: string, asOf?: number): ToolEvent | null {
    const base = this._projectBaseEvent(entity, asOf);
    const toolName = asString(this.memoryIndex.getLatestValue(entity, "toolName", asOf));
    const summary = asString(this.memoryIndex.getLatestValue(entity, "summary", asOf));

    if (!base || !toolName || !summary) return null;

    return { ...base, kind: "tool-event", toolName, summary };
  }

  private _nextTx(): number {
    return this.memoryIndex.getLatestTx() + 1;
  }

  private _getOrThrowCurrentProjection(): SessionRecord {
    if (!this.currentProjection) throw new Error("Session not initialized");
    return this.currentProjection;
  }

  private _assertInitialized(): void {
    if (!this.currentProjection) throw new Error("Session not initialized");
  }
}
