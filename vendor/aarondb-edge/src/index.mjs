import { Hono } from "hono";
import { run } from "../build/dev/javascript/aarondb_edge/aarondb_edge/engine.mjs";
import { new_state } from "../build/dev/javascript/aarondb_edge/aarondb_edge/shared/state.mjs";
import { where, to_query, v, s, new$ as newQuery } from "../build/dev/javascript/aarondb_edge/aarondb_edge/q.mjs";
import { ref, Str, Int, Float, Bool, Assert, Retract, All, new_datom, cosine_similarity } from "../build/dev/javascript/aarondb_edge/aarondb_edge/fact.mjs";
import { insert_eavt, insert_aevt } from "../build/dev/javascript/aarondb_edge/aarondb_edge/index.mjs";
import { transact, TxOp } from "../build/dev/javascript/aarondb_edge/aarondb_edge/transaction.mjs";
import { as_of } from "../build/dev/javascript/aarondb_edge/aarondb_edge/q.mjs";

/**
 * Value Serializer for D1
 */
function serializeValue(val) {
    // Simple JSON serialization for now. 
    // In a production system, we might use a more compact binary format.
    return JSON.stringify(val);
}

function deserializeValue(json) {
    return JSON.parse(json);
}

/**
 * AaronDBState Durable Object
 * The "Memory-First" agent brain with D1 Durability.
 */
export class AaronDBState {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.db = new_state();
        this.initialized = false;
        this.agentId = this.state.id.toString();
    }

    async initialize() {
        if (this.initialized) return;

        console.log(`Rehydrating AaronDB State for Agent: ${this.agentId}`);

        // Rehydrate from D1
        const { results } = await this.env.DB.prepare(
            "SELECT * FROM facts WHERE agent_id = ? ORDER BY tx ASC, tx_index ASC"
        ).bind(this.agentId).all();

        for (const row of results) {
            const val = deserializeValue(row.value);
            const op = row.operation === 1 ? Assert : Retract;
            const datom = new_datom(ref(row.entity), row.attribute, val, row.tx, row.tx_index, op);

            this.db.eavt = insert_eavt(this.db.eavt, datom, All);
            this.db.aevt = insert_aevt(this.db.aevt, datom, All);
        }

        this.initialized = true;
    }

    async fetch(request) {
        await this.initialize();
        const url = new URL(request.url);

        if (url.pathname === "/query") {
            const queryBody = await request.json().catch(() => ({}));
            // Default query if none provided
            const qBody = queryBody.q ? queryBody.q : to_query(where(newQuery(), v("e"), "type", s("agent")));

            // Support Temporal Query
            let finalQuery = qBody;
            if (queryBody.asOf) {
                // We wrap the AST query to apply temporal constraint
                // Note: In a real system we'd have a robust JSON->AST parser
                // For now we assume queryBody.q is a valid AST or we use the builder
                // This is a simplified demonstration of the 'as_of' injection
                const builder = { ...newQuery(), clauses: qBody.where, find: qBody.find };
                finalQuery = to_query(as_of(builder, queryBody.asOf));
            }

            const result = run(this.db, finalQuery);
            return new Response(JSON.stringify(result), {
                headers: { "Content-Type": "application/json" }
            });
        }

        if (url.pathname === "/insert") {
            const { e, a, v: val } = await request.json();
            const operation = Assert; // Could be passed in
            const txOp = new TxOp(ref(e), a, val, operation);

            // 1. Update In-Memory via Transactor (Atomic + Monotonic)
            const [newState, finalTx] = transact(this.db, [txOp]);
            this.db = newState;

            // 2. Persist to D1 (Async Durability)
            const opId = 1; // Assert
            this.state.waitUntil(
                this.env.DB.prepare(
                    "INSERT INTO facts (agent_id, entity, attribute, value, tx, tx_index, valid_time, operation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
                ).bind(this.agentId, e, a, serializeValue(val), finalTx, 0, 0, opId).run()
            );

            // 3. Auto-Embedding for Strings
            if (typeof val === "string" && a !== "embedding") {
                this.state.waitUntil((async () => {
                    try {
                        const { data } = await this.env.AI.run("@cf/baai/bge-small-en-v1.5", {
                            text: [val]
                        });
                        const vector = data[0];
                        const vFact = { type: "Vec", data: vector };
                        const vTxOp = new TxOp(ref(e), "embedding", vFact, Assert);

                        // Commit embedding as a separate transaction or fold into existing?
                        // For simplicity in this demo, we run another transaction.
                        const [s2, tx2] = transact(this.db, [vTxOp]);
                        this.db = s2;

                        // 4. Persistence to D1
                        await this.env.DB.prepare(
                            "INSERT INTO facts (agent_id, entity, attribute, value, tx, tx_index, valid_time, operation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
                        ).bind(this.agentId, e, "embedding", serializeValue(vFact), tx2, 0, 0, opId).run();

                        // 5. Wire Dormant Infrastructure: Cloudflare Vectorize
                        // Upsert to native vector index for global top-k scale
                        await this.env.VECTOR_INDEX.upsert([{
                            id: `${this.agentId}:${e}:${tx2}`,
                            values: vector,
                            metadata: { agentId: this.agentId, entity: e, tx: tx2 }
                        }]);
                    } catch (err) {
                        console.error("Auto-Embedding Error:", err);
                    }
                })());
            }

            return new Response("Fact asserted and logged", { status: 201 });
        }

        if (url.pathname === "/checkpoint") {
            const snapshot = JSON.stringify(this.db);
            const key = `snapshots/${this.agentId}/${Date.now()}.json`;
            await this.env.ARCHIVE.put(key, snapshot);
            return new Response(`Snapshot saved to R2 as ${key}`, { status: 200 });
        }

        if (url.pathname === "/semantic-search") {
            const { queryVector, threshold, sinceTx } = await request.json();

            // 1. Native Vectorize Lookup
            const vectorResults = await this.env.VECTOR_INDEX.query(queryVector, {
                topK: 100,
                filter: { agentId: this.agentId }
            });

            if (vectorResults.matches && vectorResults.matches.length > 0) {
                const results = vectorResults.matches
                    .filter(m => m.metadata.tx >= (sinceTx || 0) && m.score >= (threshold || 0.8))
                    .map(m => ({
                        entity: m.metadata.entity,
                        score: m.score,
                        tx: m.metadata.tx
                    }));
                return new Response(JSON.stringify(results), {
                    headers: { "Content-Type": "application/json" }
                });
            }

            // 2. Fallback to Brute-Force
            const qb = newQuery();
            const q = to_query(where(qb, v("e"), "embedding", v("v"))); // Simplified
            const candidates = run(this.db, q);
            const filtered = candidates.filter(row => {
                const val = row[2];
                const tx = row[3];
                if (tx < (sinceTx || 0)) return false;
                if (val && val.data && val.type === "Vec") {
                    const score = cosine_similarity(queryVector, val.data);
                    return score >= (threshold || 0.8);
                }
                return false;
            }).map(row => ({ entity: row[0].data, score: threshold, tx: row[3] })); // Rough map

            return new Response(JSON.stringify(filtered), {
                headers: { "Content-Type": "application/json" }
            });
        }

        return new Response("Not Found", { status: 404 });
    }
}

/**
 * AaronDB Client for Honi Agents
 */
class AaronDBClient {
    constructor(do_obj, agentName) {
        this.do = do_obj;
        this.agentName = agentName;
    }

    async query(q) {
        const res = await this.do.fetch(new Request("http://do/query", {
            method: "POST",
            body: JSON.stringify({ q })
        }));
        return res.json();
    }

    async insert(e, a, v, tx, txi) {
        const res = await this.do.fetch(new Request("http://do/insert", {
            method: "POST",
            body: JSON.stringify({ e, a, v, tx, txi })
        }));
        return res.text();
    }

    /**
     * Workers AI: Local LLM Reasoning
     * Uses Llama-3 to'think' based on Datalog context.
     */
    async reason(prompt, context, env) {
        const sysPrompt = "You are a stateful reasoning agent. Use the provided Datalog facts to inform your response.";
        const fullPrompt = `Context Facts:\n${JSON.stringify(context)}\n\nUser Question: ${prompt}`;

        return env.AI.run("@cf/meta/llama-3-8b-instruct", {
            messages: [
                { role: "system", content: sysPrompt },
                { role: "user", content: fullPrompt }
            ]
        });
    }

    /**
     * Agentic RAG: Semantic Join
     * Calls the Durable Object's semantic-search endpoint.
     */
    async semanticSearch(queryVector, attribute, threshold = 0.8, sinceTx = 0) {
        const res = await this.do.fetch(new Request("http://do/semantic-search", {
            method: "POST",
            body: JSON.stringify({ queryVector, threshold, sinceTx })
        }));
        return res.json();
    }

    /**
     * Coordination: Ask another agent a Datalog query.
     */
    async ask(otherAgentName, q, env) {
        let id = await env.CONFIG_KV.get(`agent:${otherAgentName}`);
        if (!id) return null;
        const otherObj = env.AARONDB_STATE.get(env.AARONDB_STATE.idFromString(id));
        const res = await otherObj.fetch(new Request("http://do/query", {
            method: "POST",
            body: JSON.stringify({ q })
        }));
        return res.json();
    }

    /**
     * Coordination: Tell another agent a fact.
     * Automatically adds ':source' providence.
     */
    async tell(otherAgentName, e, a, v, env) {
        let id = await env.CONFIG_KV.get(`agent:${otherAgentName}`);
        if (!id) return "Unknown Agent";
        const otherObj = env.AARONDB_STATE.get(env.AARONDB_STATE.idFromString(id));
        await otherObj.fetch(new Request("http://do/insert", {
            method: "POST",
            body: JSON.stringify({ e, a, v, tx: Date.now(), txi: 0 })
        }));
        // Meta-fact: Record that we told them
        await this.insert(e, "notified", otherAgentName);
        return "Told";
    }
}

const app = new Hono();

app.get("/", (c) => {
    return c.text("AaronDB Edge: Unified Sovereign Stack Active");
});

/**
 * Middleware to inject AaronDB client into Honi context.
 * Enables: c.get("aarondb").query(...)
 */
app.use("/agents/:name/*", async (c, next) => {
    const name = c.req.param("name");

    let id = await c.env.CONFIG_KV.get(`agent:${name}`);
    if (!id) {
        id = c.env.AARONDB_STATE.idFromName(name).toString();
        await c.env.CONFIG_KV.put(`agent:${name}`, id);
    }

    const obj = c.env.AARONDB_STATE.get(c.env.AARONDB_STATE.idFromString(id));
    c.set("aarondb", new AaronDBClient(obj, name));

    await next();
});

/**
 * Example Agent Route using the Datalog Client
 */
/**
 * Reasoning Loop Route
 * 1. Semantic Retrieval
 * 2. Datalog Filtering
 * 3. LLM Reasoning (Llama-3)
 * 4. State Committal
 */
app.post("/agents/:name/solve", async (c) => {
    const db = c.get("aarondb");
    const { problem } = await c.req.json();
    const name = c.req.param("name");

    // 1. Semantic Lookup (Find similar prior problems)
    const queryVector = await db.embed(problem, c.env);
    const relatedMemories = await db.semanticSearch(queryVector, "embedding");

    // 2. LLM Reasoning
    const reasoning = await db.reason(problem, relatedMemories, c.env);
    const answer = reasoning.response || reasoning.answer;

    // 3. Commit the new 'Memory' back to AaronDB
    await db.insert(name, "last_thought", answer);

    return c.json({
        agent: name,
        observation: problem,
        thought: answer,
        memories_consulted: relatedMemories.length
    });
});

/**
 * Coordination Route: Agent A asks Agent B for info.
 */
app.post("/agents/:name/coordinate", async (c) => {
    const db = c.get("aarondb");
    const { target, topic } = await c.req.json();
    const name = c.req.param("name");

    // 1. Ask the other agent for facts about the topic
    const q = to_query(where(newQuery(), v("e"), topic, v("v")));
    const facts = await db.ask(target, q, c.env);

    if (facts && facts.length > 0) {
        // 2. We 'learned' something from the other agent.
        // Assert it in our memory with providence.
        for (const [e, a, v] of facts) {
            await db.insert(e, "learned_from", target);
            await db.insert(e, a, v);
        }
    }

    return c.json({
        agent: name,
        status: "coordinated",
        learned_count: facts ? facts.length : 0
    });
});

/**
 * Discovery: List all known agents
 */
/**
 * Benchmark: Memory-Resident RAG Performance
 */
app.get("/agents/:name/benchmark", async (c) => {
    const db = c.get("aarondb");
    const start = Performance.now ? performance.now() : Date.now();

    // Complex query: find all learned facts from a specific source
    const q = to_query(where(newQuery(), v("e"), "learned_from", v("source")));
    const facts = await db.query(q);

    const end = Performance.now ? performance.now() : Date.now();

    return c.json({
        agent: c.req.param("name"),
        operation: "query_full_join",
        facts_count: facts.length,
        duration_ms: end - start
    });
});

export default app;
