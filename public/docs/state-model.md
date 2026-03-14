# AaronDB-style state model

AaronClaw does not run a general AaronDB service. Instead, it uses an AaronDB-style immutable fact model inside the Worker app so session memory can surviveDurable Object restarts and page reloads.

## Core idea

Each session has two representations:

1. **Hot projection in the Durable Object** — fast in-memory session state forthe active request path.
2. **Immutable fact log in D1** — the source of truth for replay and recall.

The Durable Object can be restarted at any time. When that happens, AaronClawrehydrates the projection by replaying D1 facts for the session.

## D1 schema

`migrations/0001_aarondb_edge.sql` creates one fact table:

| Column | Meaning |
| --- | --- |
| session_id | Session partition key |
| entity | Session entity or event entity |
| attribute | AaronDB-style fact attribute |
| value_json | JSON-encoded value |
| tx | Monotonic session transaction number |
| tx_index | Stable ordering inside one transaction |
| occurred_at | Event timestamp |
| operation | Currently always assert |

Facts are ordered by `(session_id, tx, tx_index)`.

## Entity model

AaronClaw writes facts for:

- the session entity itself (`sessionId`)
- message entities (`<sessionId>:message:<tx>`)
- tool-event entities (`<sessionId>:tool:<tx>`)

Common attributes include:

- session facts: `type`, `createdAt`, `lastActiveAt`
- message facts: `type`, `session`, `createdAt`, `role`, `content`, `metadata`
- tool-event facts: `type`, `session`, `createdAt`, `toolName`, `summary`, `metadata`
- recall facts: `memoryTerm`

## Write path

Each append operation creates one new transaction number:

- `createSession()` writes the initial session facts
- `appendMessage()` updates `lastActiveAt`, writes one message entity, and emits`memoryTerm` facts derived from the content
- `appendToolEvent()` does the same for tool events

No facts are updated in place. New facts extend the log.

## Replay path

On hydration, AaronClaw:

1. reads all session facts from D1 in transaction order
2. rebuilds the session envelope (`createdAt`, `lastActiveAt`, `lastTx`)
3. groups event facts by entity
4. finalizes message and tool-event projections
5. sorts events by `tx`

This produces the returned session snapshot with:

- `events`
- `messages`
- `toolEvents`
- `recallableMemoryCount`

`GET /api/sessions/:id?asOf=<tx>` uses the same projection logic but stops replayafter the specified transaction.

## Recall model

Recall is intentionally simple and local to the session.

- Content is lowercased.
- Text is split on non-alphanumeric boundaries.
- Tokens shorter than 2 characters are ignored.
- A small suffix trim removes trailing `ing`, `ed`, `es`, and `s`.
- Unique surviving terms are stored as `memoryTerm` facts for that event.

At query time, AaronClaw compares the query terms to each event's stored recallterms, scores matches by overlap, sorts by score and recency, and returns thetop results.

## Why this matters operationally

- Losing Durable Object memory does not lose the session.
- Reloading the browser or restarting a Durable Object still permits replay.
- The session state model is inspectable and deterministic enough for handoff and
  troubleshooting of both human-led sessions and autonomous optimization engines.
- Workers AI is optional for persistence: state durability comes from D1 facts.

For route-level behavior, see `docs/runtime.md`.