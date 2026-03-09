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

interface AaronDbFactRecord {
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
}

interface EventDraft {
  id: string;
  tx: number;
  kind?: SessionEventKind;
  createdAt?: string;
  role?: MessageRole;
  content?: string;
  toolName?: string;
  summary?: string;
  metadata: JsonObject | null;
  recallTerms: Set<string>;
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

function previewForEvent(event: SessionEvent): string {
  return event.kind === "message"
    ? event.content
    : `${event.toolName}: ${event.summary}`;
}

function finalizeEvent(draft: EventDraft): SessionEvent | null {
  const recallTerms = [...draft.recallTerms].sort();

  if (draft.kind === "message" && draft.createdAt && draft.role && draft.content) {
    return {
      id: draft.id,
      kind: "message",
      createdAt: draft.createdAt,
      tx: draft.tx,
      role: draft.role,
      content: draft.content,
      metadata: draft.metadata,
      recallTerms
    };
  }

  if (
    draft.kind === "tool-event" &&
    draft.createdAt &&
    draft.toolName &&
    draft.summary
  ) {
    return {
      id: draft.id,
      kind: "tool-event",
      createdAt: draft.createdAt,
      tx: draft.tx,
      toolName: draft.toolName,
      summary: draft.summary,
      metadata: draft.metadata,
      recallTerms
    };
  }

  return null;
}

export class AaronDbEdgeSessionRepository implements SessionStateRepository {
  private facts: AaronDbFactRecord[] = [];
  private hydrated = false;
  private hydratePromise: Promise<void> | null = null;
  private currentProjection: SessionRecord | null = null;

  constructor(
    private readonly database: D1Database,
    private readonly sessionId: string
  ) {}

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
    const session = await this.getSession({ asOf: input.asOf });

    if (!session) {
      return [];
    }

    const queryTerms = tokenize(input.query);

    if (queryTerms.length === 0) {
      return [];
    }

    return session.events
      .map((event) => {
        const matchedTerms = event.recallTerms.filter((term) =>
          queryTerms.includes(term)
        );

        if (matchedTerms.length === 0) {
          return null;
        }

        return {
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
    const result = await this.database
      .prepare(FACT_SELECT_SQL)
      .bind(this.sessionId)
      .all<AaronDbFactRow>();

    this.facts = (result.results ?? []).map((row) => ({
      sessionId: row.session_id,
      entity: row.entity,
      attribute: row.attribute,
      value: JSON.parse(row.value_json) as JsonValue,
      tx: row.tx,
      txIndex: row.tx_index,
      occurredAt: row.occurred_at,
      operation: row.operation
    }));
    this.currentProjection = this.project();
    this.hydrated = true;
  }

  private async appendFacts(facts: AaronDbFactRecord[]): Promise<void> {
    await this.database.batch(
      facts.map((fact) =>
        this.database
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

    this.facts.push(...facts);
    this.currentProjection = this.project();
  }

  private project(asOf?: number): SessionRecord | null {
    if (this.facts.length === 0) {
      return null;
    }

    const eventDrafts = new Map<string, EventDraft>();
    let sessionExists = false;
    let createdAt = "";
    let lastActiveAt = "";
    let lastTx = 0;

    for (const fact of this.facts) {
      if (asOf !== undefined && fact.tx > asOf) {
        break;
      }

      lastTx = Math.max(lastTx, fact.tx);

      if (fact.entity === this.sessionId) {
        if (fact.attribute === "type" && fact.value === "session") {
          sessionExists = true;
        }

        if (fact.attribute === "createdAt" && typeof fact.value === "string") {
          createdAt = fact.value;
        }

        if (fact.attribute === "lastActiveAt" && typeof fact.value === "string") {
          lastActiveAt = fact.value;
        }

        continue;
      }

      let draft = eventDrafts.get(fact.entity);

      if (!draft) {
        draft = {
          id: fact.entity,
          tx: fact.tx,
          metadata: null,
          recallTerms: new Set<string>()
        };
        eventDrafts.set(fact.entity, draft);
      }

      draft.tx = Math.max(draft.tx, fact.tx);

      switch (fact.attribute) {
        case "type":
          if (fact.value === "message" || fact.value === "tool-event") {
            draft.kind = fact.value;
          }
          break;
        case "createdAt":
          if (typeof fact.value === "string") {
            draft.createdAt = fact.value;
          }
          break;
        case "role":
          if (fact.value === "user" || fact.value === "assistant") {
            draft.role = fact.value;
          }
          break;
        case "content":
          if (typeof fact.value === "string") {
            draft.content = fact.value;
          }
          break;
        case "toolName":
          if (typeof fact.value === "string") {
            draft.toolName = fact.value;
          }
          break;
        case "summary":
          if (typeof fact.value === "string") {
            draft.summary = fact.value;
          }
          break;
        case "metadata":
          if (fact.value && typeof fact.value === "object" && !Array.isArray(fact.value)) {
            draft.metadata = fact.value as JsonObject;
          }
          break;
        case "memoryTerm":
          if (typeof fact.value === "string") {
            draft.recallTerms.add(fact.value);
          }
          break;
        default:
          break;
      }
    }

    if (!sessionExists) {
      return null;
    }

    const events = [...eventDrafts.values()]
      .map((draft) => finalizeEvent(draft))
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
      lastActiveAt: lastActiveAt || createdAt,
      lastTx,
      persistence: "aarondb-edge",
      memorySource: "aarondb-edge",
      events,
      messages,
      toolEvents,
      recallableMemoryCount: events.filter((event) => event.recallTerms.length > 0)
        .length
    };
  }

  private nextTx(): number {
    return (this.facts[this.facts.length - 1]?.tx ?? 0) + 1;
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