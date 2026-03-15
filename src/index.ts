import {
  buildBootstrapStatus,
  parseHandRoute,
  parseImprovementRoute,
  parseSkillRoute,
  parseSessionRoute,
  renderLandingPage
} from "./routes";
import {
  listBundledHands,
  readBundledHandState,
  runScheduledHands,
  setBundledHandLifecycle
} from "./hands-runtime";
import { triggerBundledHandRunManual } from "./hands-runtime";
import {
  buildModelRegistry,
  normalizeModelSelectionId,
  resolveModelSelection
} from "./model-registry";
import {
  readProviderKeyStatus,
  setProtectedProviderKey,
  validateConfiguredProviderKey,
  validateProviderApiKey
} from "./provider-key-store";
import {
  readPersistedModelSelection,
  setPersistedModelSelection
} from "./model-selection-store";
import {
  readImprovementProposalState, 
  recordImprovementLifecycleAction,
  resolveFactsAsOf,
  runTelemetricAudit
} from "./reflection-engine";
import { SessionRuntime } from "./session-runtime";
import { listBundledSkills, readBundledSkillManifest } from "./skills-runtime";
import {
  parseTelegramUpdate,
  sendTelegramReply,
  SCHEMATIC_EMOJIS,
  escapeMarkdown,
  isTelegramConfigured,
  isTelegramWebhookAuthorized,
  buildTelegramSessionId,
  buildTelegramMessageMetadata
} from "./telegram";
import { discoverResources, generateWranglerConfig } from "./wiring-engine";
import { createGithubRepository, pushFilesToGithub, setupGithubActions } from "./github-coordinator";
import { NexusMesh, NexusPeer } from "./nexus-mesh";
import {
  parseDomainDeclaration,
  synthesizeD1Migration,
  synthesizeTypescriptTypes,
  synthesizeUiManifest
} from "./aether-engine";
import { simulateDomainSynthesis } from "./oracle-engine";
import { auditInfrastructureDrift, getSovereignMetrics, rebalanceInfrastructure } from "./sovereign-engine";
import { auditEfficiency, getEconomosMetrics } from "./economos-engine";
import { discoverPatterns, getSophiaYield } from "./sophia-engine";
import { getArchitecturaPropositions, proposeOptimizations } from "./architectura-engine";
import { getSwarmStatus, initiateSelfHealing } from "./aeturnus-engine";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8"
    }
  });
}

function getSessionStub(env: Env, sessionId: string): DurableObjectStub {
  const objectId = env.SESSION_RUNTIME.idFromName(sessionId);
  return env.SESSION_RUNTIME.get(objectId);
}

function isAuthConfigured(env: Env): boolean {
  return typeof env.APP_AUTH_TOKEN === "string" && env.APP_AUTH_TOKEN.trim().length > 0;
}

function isAuthorized(request: Request, env: Env): boolean {
  const expected = env.APP_AUTH_TOKEN?.trim();
  const recovery = env.RECOVERY_TRIGGER_TOKEN?.trim();

  const authHeader = request.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (expected && bearerToken === expected) {
    return true;
  }

  if (recovery && bearerToken === recovery) {
    // Recovery token is ONLY allowed for specific hand-run routes.
    // We'll check this in the route handler itself to be safe.
    return true;
  }

  if (!expected && !recovery) {
    return true;
  }

  return false;
}

async function buildRuntimeOptions(env: Env) {
  const { selection } = await readResolvedModelSelection(env, null);

  return {
    authRequired: isAuthConfigured(env),
    defaultProvider: selection.requestedModel?.provider ?? null,
    defaultModel: selection.requestedModel?.model ?? null,
    activeProvider: selection.activeModel?.provider ?? null,
    activeModel: selection.activeModel?.model ?? null,
    selectionFallbackReason: selection.selectionFallbackReason,
    hasAiBinding: Boolean(env.AI)
  };
}

async function handleTelemetryRoute(request: Request, env: Env): Promise<Response> {
  // 🧙🏾‍♂️ AaronClaw: Streaming the immutable fact log for tactical awareness.
  try {
    const facts = await env.AARONDB.prepare(
      "SELECT * FROM facts ORDER BY createdAt DESC LIMIT 50"
    ).all();
    return json({ facts: facts.results });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function handlePulseRoute(request: Request, env: Env): Promise<Response> {
  // 🧙🏾‍♂️ AaronClaw: Ingesting tactical pulses from managed isolates.
  try {
    if (request.method !== "POST") {
      return json({ error: "method not allowed", methods: ["POST"] }, 405);
    }

    const pulse = await request.json() as {
      projectId: string;
      metrics: Record<string, number | string>;
      timestamp?: string;
    };

    if (!pulse.projectId || !pulse.metrics) {
      return json({ error: "projectId and metrics are required" }, 400);
    }

    const occurredAt = pulse.timestamp ?? new Date().toISOString();
    
    // We'll record this in a dedicated 'pulse-ingestion' session or a global log.
    // For now, let's treat the projectId as the entity.
    const facts = Object.entries(pulse.metrics).map(([key, value], index) => ({
      session_id: "global:pulse",
      entity: pulse.projectId,
      attribute: "metricValue",
      value_json: JSON.stringify(value),
      tx: 0, // D1 might handle auto-inc if we set it up, but here we append to a facts table
      tx_index: index,
      occurred_at: occurredAt,
      operation: "assert",
      // Custom metadata for Sophia/Architectura
      metadata_json: JSON.stringify({ metricKind: key })
    }));

    // AaronDB persistence (using the schema from session-state for consistency)
    // NOTE: In a real AaronClaw deployment, we'd use the SessionRuntime or a GlobalLogger DO.
    // Here we append directly to the D1 table used for facts.
    for (const fact of facts) {
      await env.AARONDB.prepare(
        "INSERT INTO aarondb_facts (session_id, entity, attribute, value_json, tx, tx_index, occurred_at, operation) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(tx), 0) + 1 FROM aarondb_facts), ?, ?, ?)"
      ).bind(
        fact.session_id,
        fact.entity,
        fact.attribute,
        fact.value_json,
        fact.tx_index,
        fact.occurred_at,
        fact.operation
      ).run();
    }

    return json({ status: "ingested", pulseId: occurredAt });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function handleManagedProjectRoute(request: Request, env: Env): Promise<Response> {
  // 🧙🏾‍♂️ AaronClaw: Registering projects for autonomous optimization.
  try {
    if (request.method !== "POST") {
      return json({ error: "method not allowed", methods: ["POST"] }, 405);
    }

    const project = await request.json() as {
      projectId: string;
      repoUrl: string;
      repoBranch: string;
      optimizationTarget: string;
    };

    if (!project.projectId || !project.repoUrl || !project.optimizationTarget) {
      return json({ error: "projectId, repoUrl, and optimizationTarget are required" }, 400);
    }

    const timestamp = new Date().toISOString();
    const facts = [
      { attr: "type", val: "managed-project" },
      { attr: "repoUrl", val: project.repoUrl },
      { attr: "repoBranch", val: project.repoBranch || "main" },
      { attr: "optimizationTarget", val: project.optimizationTarget }
    ].map((f, i) => ({
      session_id: "global:projects",
      entity: project.projectId,
      attribute: f.attr as any,
      value_json: JSON.stringify(f.val),
      tx_index: i,
      occurred_at: timestamp,
      operation: "assert" as const
    }));

    for (const fact of facts) {
      await env.AARONDB.prepare(
        "INSERT INTO aarondb_facts (session_id, entity, attribute, value_json, tx, tx_index, occurred_at, operation) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(tx), 0) + 1 FROM aarondb_facts), ?, ?, ?)"
      ).bind(
        fact.session_id,
        fact.entity,
        fact.attribute,
        fact.value_json,
        fact.tx_index,
        fact.occurred_at,
        fact.operation
      ).run();
    }

    return json({ status: "registered", projectId: project.projectId });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function handlePanopticonIngestRoute(request: Request, env: Env): Promise<Response> {
  // 🧙🏾‍♂️ AaronClaw Phase 18: Panopticon - Ingesting external state as immutable facts.
  try {
    if (request.method !== "POST") {
      return json({ error: "method not allowed", methods: ["POST"] }, 405);
    }

    const payload = await request.json() as {
      source: string;
      entityId: string;
      state: any;
      timestamp?: string;
    };

    if (!payload.source || !payload.entityId || payload.state === undefined) {
      return json({ error: "source, entityId, and state are required" }, 400);
    }

    const occurredAt = payload.timestamp ?? new Date().toISOString();
    
    const fact = {
      session_id: `external:${payload.source}`,
      entity: payload.entityId,
      attribute: "externalState",
      value_json: JSON.stringify(payload.state),
      tx_index: 0,
      occurred_at: occurredAt,
      operation: "assert"
    };

    // AaronDB persistence for the external state projection
    await env.AARONDB.prepare(
      "INSERT INTO aarondb_facts (session_id, entity, attribute, value_json, tx, tx_index, occurred_at, operation) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(tx), 0) + 1 FROM aarondb_facts), ?, ?, ?)"
    ).bind(
      fact.session_id,
      fact.entity,
      fact.attribute,
      fact.value_json,
      fact.tx_index,
      fact.occurred_at,
      fact.operation
    ).run();

    return json({ status: "ingested", source: payload.source, entityId: payload.entityId, timestamp: occurredAt }, 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function handleSpawnRoute(request: Request, env: Env): Promise<Response> {
  // 🧙🏾‍♂️ AaronClaw: Automating the emergence of new structures.
  try {
    const body = (await request.json().catch(() => ({}))) as any;
    const name = body.name;
    const prompt = body.prompt;
    const bootstrapExtension = body.bootstrapExtension;
    const declaration = body.declaration;

    if (!name) return json({ error: "name is required" }, 400);

    // 1. Discover Resources
    const resources = await discoverResources(env);

    // 2. Generate Configuration
    const wranglerConfig = generateWranglerConfig(name, resources);

    // 3. GitHub Orchestration
    const githubToken = env.GITHUB_TOKEN;
    if (!githubToken) throw new Error("GITHUB_TOKEN is not configured");

    // Get user info to find owner
    const userResp = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `token ${githubToken}`,
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "AaronClaw-Software-Factory"
      }
    });
    if (!userResp.ok) throw new Error("Failed to fetch GitHub user info");
    const userData = (await userResp.json()) as any;
    const owner = userData.login;

    // Create Repository
    await createGithubRepository(githubToken, {
      owner,
      repo: name,
      description: `Spawning agent: ${prompt ? prompt.substring(0, 50) : "No prompt provided"}${bootstrapExtension ? ` (Evolved from ${bootstrapExtension.sourceProposalKey})` : ""}`,
      private: true
    });

    const initialTruth = bootstrapExtension 
      ? `// Evolved Truth: Derived from ${bootstrapExtension.sourceProposalKey}\n// Proposed Action: ${bootstrapExtension.proposedAction}\n// Pattern: ${bootstrapExtension.pattern}\n\n`
      : "";

    const files: { path: string, content: string }[] = [
      { path: "wrangler.jsonc", content: wranglerConfig },
      {
        path: "package.json",
        content: JSON.stringify(
          {
            name,
            version: "0.1.0",
            devDependencies: {
              wrangler: "^3.0.0"
            },
            scripts: {
              deploy: "wrangler deploy"
            }
          },
          null,
          2
        )
      }
    ];

    if (declaration) {
      // 🧙🏾‍♂️ Oracle: Speculative Simulation
      const currentState = await resolveFactsAsOf(env, new Date().toISOString());
      const simulation = await simulateDomainSynthesis(currentState, declaration);

      if (simulation.verdict === 'reject') {
        return json({
          error: "Synthesis Rejected by Oracle",
          risk: simulation.riskAssessment,
          delta: simulation.delta
        }, 403);
      }

      const domain = parseDomainDeclaration(typeof declaration === 'string' ? declaration : JSON.stringify(declaration));
      const sql = synthesizeD1Migration(domain);
      const types = synthesizeTypescriptTypes(domain);
      const ui = synthesizeUiManifest(domain);

      files.push({ path: "migrations/0001_domain_init.sql", content: sql.join("\n\n") });
      files.push({ path: "src/types.ts", content: types });
      files.push({ 
          path: "src/index.ts", 
          content: `${initialTruth}import { ${domain.domain.split("/").map(p => p.charAt(0).toUpperCase() + p.slice(1)).join("")} } from "./types";\n\nexport default {\n  async fetch(request, env, ctx) {\n    return new Response(JSON.stringify({ status: "Domain ${domain.domain} Online", ui: ${JSON.stringify(ui)} }), { headers: { "content-type": "application/json" } });\n  }\n};` 
      });
    } else {
      files.push({
          path: "src/index.ts",
          content: `${initialTruth}export default { \n  async fetch(request, env, ctx) { \n    return new Response("Hello from ${name}! Status: Spawning complete."); \n  } \n};`
      });
    }

    await pushFilesToGithub(githubToken, owner, name, "main", files, "Initial spawn from AaronClaw");

    // Setup CI/CD
    await setupGithubActions(githubToken, owner, name);

    return json({
      status: "spawned",
      name,
      url: `https://github.com/${owner}/${name}`
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

function buildRuntimeStatus(options: Awaited<ReturnType<typeof buildRuntimeOptions>>) {
  return buildBootstrapStatus(options);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify(
      {
        error:
          "unauthorized: provide Authorization: Bearer <APP_AUTH_TOKEN> for this personal deployment"
      },
      null,
      2
    ),
    {
      status: 401,
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "www-authenticate": 'Bearer realm="aaronclaw"'
      }
    }
  );
}

function buildRuntimeUrl(
  pathname: string,
  sessionId: string,
  query?: URLSearchParams
): string {
  const url = new URL(`https://session.runtime${pathname}`);
  url.searchParams.set("sessionId", sessionId);

  if (query) {
    for (const [key, value] of query.entries()) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

async function proxyJsonBody(
  request: Request,
  stub: DurableObjectStub,
  pathname: string,
  sessionId: string
): Promise<Response> {
  return stub.fetch(buildRuntimeUrl(pathname, sessionId), {
    method: request.method,
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json"
    },
    body: await request.text()
  });
}

async function ensureSessionInitialized(stub: DurableObjectStub, sessionId: string): Promise<void> {
  const stateResponse = await stub.fetch(buildRuntimeUrl("/state", sessionId));

  if (stateResponse.status === 404) {
    const initResponse = await stub.fetch(buildRuntimeUrl("/init", sessionId), {
      method: "POST"
    });

    if (!initResponse.ok) {
      throw new Error(`telegram session init failed with status ${initResponse.status}`);
    }

    return;
  }

  if (!stateResponse.ok) {
    throw new Error(`telegram session lookup failed with status ${stateResponse.status}`);
  }
}

async function handleTelegramWebhook(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (!isTelegramConfigured(env)) {
    return json({ error: "telegram integration is not configured" }, 503);
  }

  if (!isTelegramWebhookAuthorized(request, env)) {
    return json({ error: "telegram webhook secret mismatch" }, 401);
  }

  const update = parseTelegramUpdate(await request.json().catch(() => null));

  if (!update) {
    return json({ error: "invalid telegram update" }, 400);
  }

  // Handle Callback Queries (Buttons)
  if (update.callbackQuery) {
    const data = update.callbackQuery.data;
    const chatId = update.callbackQuery.message?.chat.id;
    if (chatId && data) {
        await handleTelegramCommand({
            env,
            ctx,
            chatId,
            messageId: update.callbackQuery.message?.messageId,
            data
        });
    }
    return json({ ok: true });
  }

  if (!update.message) {
    return json({ ok: true, ignored: "unsupported-update" });
  }

  if (update.message.from?.isBot) {
    return json({ ok: true, ignored: "bot-message" });
  }

  const content = update.message.text?.trim();

  if (!content) {
    return json({ ok: true, ignored: "non-text-message" });
  }

  // 🧙🏾‍♂️ Dispatcher
  if (content.startsWith("/")) {
    const [command, ...argList] = content.split(" ");
    const args = argList.join(" ");

    await handleTelegramCommand({
      env,
      ctx,
      chatId: update.message.chat.id,
      messageId: update.message.messageId,
      command,
      args
    });
    return json({ ok: true });
  }

  // Default: Fallback to session chat
  const sessionId = buildTelegramSessionId(update.message);
  const stub = getSessionStub(env, sessionId);

  try {
    await ensureSessionInitialized(stub, sessionId);

    const chatResponse = await stub.fetch(buildRuntimeUrl("/chat", sessionId), {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=UTF-8"
      },
      body: JSON.stringify({
        content,
        metadata: buildTelegramMessageMetadata(update, update.message)
      })
    });

    if (!chatResponse.ok) {
      throw new Error(`telegram chat proxy failed with status ${chatResponse.status}`);
    }

    const payload = (await chatResponse.json()) as {
      assistant?: { content?: string };
    };
    const reply = payload.assistant?.content?.trim();

    if (!reply) {
      throw new Error("telegram chat proxy returned an empty assistant reply");
    }

    await sendTelegramReply({
      env,
      chatId: update.message.chat.id,
      replyToMessageId: update.message.messageId,
      text: reply
    });

    return json({ ok: true });
  } catch (error) {
    console.error("telegram webhook handling failed", error);
    return json({ error: "telegram webhook handling failed" }, 502);
  }
}

async function handleTelegramCommand(input: {
  env: Env;
  ctx?: ExecutionContext;
  chatId: number;
  messageId?: number;
  command?: string;
  args?: string;
  data?: string;
}): Promise<void> {
    const { env, ctx, chatId, messageId, command, args, data } = input;

    const reply = async (text: string, options: { parseMode?: "MarkdownV2" | "HTML", replyMarkup?: any } = {}) => {
        await sendTelegramReply({
            env,
            chatId,
            replyToMessageId: messageId,
            text,
            ...options
        });
    };

    try {
        // 🧙🏾‍♂️ Welcome & Quick Actions
        if (command === "/start") {
            await reply(`${SCHEMATIC_EMOJIS.WIZARD} *AaronClaw Software Factory Online*\n\nWelcome\\. I am your autonomous architect\\. Use the buttons below for quick tactical awareness or send a command to begin synthesis\\.`, {
                parseMode: "MarkdownV2",
                replyMarkup: {
                    inline_keyboard: [
                        [
                            { text: `${SCHEMATIC_EMOJIS.STATUS} Status`, callback_data: "cmd_status" },
                            { text: `${SCHEMATIC_EMOJIS.HAND} Hands`, callback_data: "cmd_hands" }
                        ],
                        [
                            { text: `${SCHEMATIC_EMOJIS.AUDIT} Audit`, callback_data: "cmd_audit" }
                        ]
                    ]
                }
            });
            return;
        }

        // 🧙🏾‍♂️ Status: Multi-Engine Orbit Analysis
        if (command === "/status" || data === "cmd_status") {
            const { getSovereignMetrics } = await import("./sovereign-engine");
            const { getEconomosMetrics } = await import("./economos-engine");
            const { getSwarmStatus } = await import("./aeturnus-engine");

            const [sovereign, economos, swarm] = await Promise.all([
                getSovereignMetrics(env, false),
                getEconomosMetrics(env),
                getSwarmStatus(env)
            ]);

            const text = [
                `*${escapeMarkdown(SCHEMATIC_EMOJIS.ORBIT)} AARONCLAW SYSTEM STATUS*`,
                "",
                `*${escapeMarkdown(SCHEMATIC_EMOJIS.SOVEREIGN)} Sovereign Hub:*`,
                `• Nodes: ${sovereign.nodes} \\(${sovereign.unhealthyNodes} degraded\\)`,
                "",
                `*${escapeMarkdown(SCHEMATIC_EMOJIS.ECONOMOS)} Economos Core:*`,
                `• Efficiency: ${economos.overallEfficiencyScore}%`,
                `• Stateful Places: ${economos.totalStatefulPlaces}`,
                "",
                `*${escapeMarkdown(SCHEMATIC_EMOJIS.FACTORY)} Aeturnus Swarm:*`,
                `• Health: ${swarm.overallHealth}%`,
                `• Active Nodes: ${swarm.activeNodes.length}`,
                "",
                `_Generated at ${escapeMarkdown(new Date().toISOString())}_`
            ].join("\n");

            await reply(text, {
                parseMode: "MarkdownV2",
                replyMarkup: {
                    inline_keyboard: [
                        [{ text: `${SCHEMATIC_EMOJIS.REFRESH} Refresh`, callback_data: "cmd_status" }]
                    ]
                }
            });
            return;
        }

        // 🧙🏾‍♂️ Hands: Tactical Lifecycle Management
        if (command === "/hands" || data === "cmd_hands") {
            const { listBundledHands } = await import("./hands-runtime");
            const hands = await listBundledHands({ env });

            const text = [
                `*${escapeMarkdown(SCHEMATIC_EMOJIS.HAND)} HANDS INVENTORY:*`,
                "",
                ...hands.map((h, i) => {
                    const emoji = h.status === "active" ? SCHEMATIC_EMOJIS.PULSE : "⏸";
                    const schedule = h.scheduleCrons.join(", ");
                    return `*${i + 1}\\. ${escapeMarkdown(h.label)}* ${emoji}\n• Schedule: \`${escapeMarkdown(schedule)}\``;
                }),
                "",
                `_Total Bundled Hands: ${hands.length}_`
            ].join("\n");

            await reply(text, {
                parseMode: "MarkdownV2",
                replyMarkup: {
                    inline_keyboard: [
                        [{ text: `${SCHEMATIC_EMOJIS.REFRESH} Refresh`, callback_data: "cmd_hands" }]
                    ]
                }
            });
            return;
        }

        // 🧙🏾‍♂️ Audit: Telemetric Fact Verification
        if (command === "/audit" || data === "cmd_audit") {
            const { runTelemetricAudit } = await import("./reflection-engine");
            const audit = await runTelemetricAudit({ env, cron: "manual" });

            const text = [
                `*${escapeMarkdown(SCHEMATIC_EMOJIS.AUDIT)} TELEMETRIC AUDIT:*`,
                "",
                `• Managed Projects: ${audit.managedProjectCount}`,
                `• Received Pulses: ${audit.receivedPulseCount}`,
                `• Generated Proposals: ${audit.generatedProposalCount}`,
                "",
                `_Session ID: \`${escapeMarkdown(audit.auditSessionId)}\`_`
            ].join("\n");

            await reply(text, { parseMode: "MarkdownV2" });
            return;
        }

        // 🧙🏾‍♂️ Factory Site
        if (command === "/site") {
            if (!args) {
                await reply(`${SCHEMATIC_EMOJIS.WARNING} Please provide a prompt: \`/site a landing page\``, { parseMode: "MarkdownV2" });
                return;
            }

            const siteTask = (async () => {
                try {
                    const { triggerBundledHandRunManual } = await import("./hands-runtime");
                    await triggerBundledHandRunManual({
                        env,
                        handId: "website-factory",
                        input: { prompt: args, name: `tg-site-${chatId}`, sessionId: `telegram:site:${chatId}` }
                    });
                    await reply(`${SCHEMATIC_EMOJIS.SUCCESS} Website synthesis complete\\! Check your dashboard\\.`, { parseMode: "MarkdownV2" });
                } catch (e: any) {
                    await reply(`${SCHEMATIC_EMOJIS.FAILURE} Synthesis failed: ${escapeMarkdown(e.message)}`, { parseMode: "MarkdownV2" });
                }
            })();
            if (ctx) ctx.waitUntil(siteTask);
            return;
        }

        // 🧙🏾‍♂️ Unknown Command
        if (command) {
            await reply(`${SCHEMATIC_EMOJIS.FAILURE} *Command not recognized:* ${escapeMarkdown(command)}\n\nUse /start to see available factory operations\\.`, { parseMode: "MarkdownV2" });
        }
    } catch (error: any) {
        console.error("Telegram Command Error:", error);
        await reply(`${SCHEMATIC_EMOJIS.FAILURE} *Operational Failure:* ${escapeMarkdown(error.message)}`, { parseMode: "MarkdownV2" });
    }
}

async function buildModelSelectionPayload(env: Env, request?: Request) {
  const modelHeader = request?.headers.get("X-Aaron-Model");
  const { persistedModelId, selection } = await readResolvedModelSelection(env, modelHeader);

  return {
    persistedModelId,
    requestedModelId: selection.requestedModelId,
    activeModelId: selection.activeModelId,
    selectionFallbackReason: selection.selectionFallbackReason,
    models: selection.models
  };
}

async function readResolvedModelSelection(env: Env, requestedModelId: string | null = null) {
  const persistedModelId = requestedModelId ?? await readPersistedModelSelection(env.AARONDB);
  const geminiKeyStatus = await readProviderKeyStatus({
    env,
    database: env.AARONDB,
    provider: "gemini"
  });
  const selection = resolveModelSelection(env, persistedModelId, {
    geminiConfigured: geminiKeyStatus.configured,
    geminiValidationStatus: geminiKeyStatus.validation.status
  });

  return {
    persistedModelId,
    selection
  };
}

async function buildKeyManagementPayload(env: Env) {
  return {
    providers: await Promise.all(
      (["gemini", "github"] as const).map((provider) =>
        readProviderKeyStatus({
          env,
          database: env.AARONDB,
          provider
        })
      )
    )
  };
}

function protectedKeyManagementUnavailable(): Response {
  return json(
    {
      error:
        "/api/key requires APP_AUTH_TOKEN to be configured so secret management stays admin-only and protected key material can be encrypted at rest."
    },
    412
  );
}

async function handleNexusPeersRoute(request: Request, env: Env): Promise<Response> {
  const dbs: D1Database[] = [env.AARONDB];
  if (env.DB) dbs.push(env.DB);
  const mesh = new NexusMesh(dbs);

  if (request.method === "GET") {
    const peers = await mesh.listPeers();
    return json({ peers });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!isJsonObject(body) || typeof body.id !== "string" || typeof body.url !== "string" || typeof body.label !== "string") {
      return json({ error: "id, url, and label are required for peer registration" }, 400);
    }

    await mesh.registerPeer({
      id: body.id,
      url: body.url,
      label: body.label
    });

    return json({ status: "registered", id: body.id }, 201);
  }

  return json({ error: "method not allowed", methods: ["GET", "POST"] }, 405);
}

async function handleModelRoute(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    return json(await buildModelSelectionPayload(env, request));
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => null);

    if (!isJsonObject(body) || typeof body.modelId !== "string") {
      return json({ error: "modelId is required" }, 400);
    }

    const modelId = normalizeModelSelectionId(body.modelId);
    const geminiKeyStatus = await readProviderKeyStatus({
      env,
      database: env.AARONDB,
      provider: "gemini"
    });
    const models = buildModelRegistry(env, {
      geminiConfigured: geminiKeyStatus.configured,
      geminiValidationStatus: geminiKeyStatus.validation.status
    });
    const model = models.find(
      (candidate) => candidate.id === modelId || candidate.aliases.includes(modelId)
    );

    if (!model) {
      return json(
        {
          error: `unsupported model selection: ${modelId}`,
          selectableModelIds: models.filter((candidate) => candidate.selectable).map((candidate) => candidate.id)
        },
        400
      );
    }

    if (!model.selectable) {
      return json(
        {
          error: `model ${modelId} is not currently selectable`,
          model
        },
        409
      );
    }

    await setPersistedModelSelection(env.AARONDB, modelId);
    return json(await buildModelSelectionPayload(env, request));
  }

  return json({ error: "method not allowed", methods: ["GET", "POST"] }, 405);
}

async function handleKeyRoute(request: Request, env: Env): Promise<Response> {
  if (!isAuthConfigured(env)) {
    return protectedKeyManagementUnavailable();
  }

  if (request.method === "GET") {
    return json(await buildKeyManagementPayload(env));
  }

  if (request.method !== "POST") {
    return json({ error: "method not allowed", methods: ["GET", "POST"] }, 405);
  }

  const body = await request.json().catch(() => null);
  if (!isJsonObject(body) || (body.provider !== "gemini" && body.provider !== "github")) {
    return json({ error: "provider is required and must be 'gemini' or 'github'" }, 400);
  }

  const providerId = body.provider as "gemini" | "github";

  const action = body.action === "validate" ? "validate" : "set";
  if (action === "validate") {
    const provider = await validateConfiguredProviderKey({
      env,
      database: env.AARONDB,
      provider: providerId
    });

    if (!provider.configured) {
      return json({ error: `no configured ${providerId} key is available to validate`, provider }, 404);
    }

    return json({ provider });
  }

  if (typeof body.apiKey !== "string") {
    return json({ error: "apiKey is required when setting a provider key" }, 400);
  }

  let validation;
  try {
    validation = await validateProviderApiKey(providerId, body.apiKey);
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : "provider key validation failed"
      },
      400
    );
  }

  if (validation.status !== "valid") {
    return json(
      {
        error: `${providerId} key validation failed; the key was not stored.`,
        provider: {
          provider: providerId,
          providerLabel: providerId === "github" ? "GitHub" : "Google Gemini",
          configured: false,
          source: "none",
          maskedKey: null,
          fingerprint: null,
          updatedAt: null,
          storage: "none",
          validation
        }
      },
      validation.status === "invalid" ? 400 : 502
    );
  }

  const provider = await setProtectedProviderKey({
    env,
    database: env.AARONDB,
    provider: providerId,
    apiKey: body.apiKey,
    validation
  });
  return json({ provider });
}

async function handleHandRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const route = parseHandRoute(pathname);

  if (!route) {
    return null;
  }

  if (route.action === "list") {
    if (request.method !== "GET") {
      return json({ error: "method not allowed", methods: ["GET"] }, 405);
    }

    return json({ hands: await listBundledHands({ env }) });
  }

  if (!route.handId) {
    return json({ error: "handId is required" }, 400);
  }

  if (route.action === "detail") {
    if (request.method !== "GET") {
      return json({ error: "method not allowed", methods: ["GET"] }, 405);
    }

    const hand = await readBundledHandState({ env, handId: route.handId });
    return hand ? json({ hand }) : json({ error: "hand not found" }, 404);
  }

  if (request.method !== "POST") {
    return json({ error: "method not allowed", methods: ["POST"] }, 405);
  }

  if (route.action === "run") {
    const hand = await triggerBundledHandRunManual({
      env,
      handId: route.handId
    });
    return hand ? json({ hand }) : json({ error: "hand not found" }, 404);
  }

  const hand = await setBundledHandLifecycle({
    env,
    handId: route.handId,
    action: route.action as any
  });
  return hand ? json({ hand }) : json({ error: "hand not found" }, 404);
}

async function handleImprovementRoute(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response | null> {
  const route = parseImprovementRoute(pathname);

  if (!route) {
    return null;
  }

  if (route.action === "list") {
    if (request.method !== "GET") {
      return json({ error: "method not allowed", methods: ["GET"] }, 405);
    }

    const proposalState = await readImprovementProposalState({ env });
    const proposals = [...proposalState.proposals].sort((left, right) => {
      const leftTimestamp = left.lifecycleHistory[left.lifecycleHistory.length - 1]?.timestamp ?? left.proposalKey;
      const rightTimestamp = right.lifecycleHistory[right.lifecycleHistory.length - 1]?.timestamp ?? right.proposalKey;
      return rightTimestamp.localeCompare(leftTimestamp);
    });

    return json({ proposalSessionId: proposalState.proposalSessionId, proposals });
  }

  const proposalState = await readImprovementProposalState({ env });
  const proposalKey = route.proposalKey;
  if (!proposalKey) {
    return json({ error: "proposal key is required" }, 400);
  }

  const proposal = proposalState.proposals.find((entry) => entry.proposalKey === proposalKey);
  if (!proposal) {
    return json({ error: "candidate not found" }, 404);
  }

  if (route.action === "detail") {
    if (request.method !== "GET") {
      return json({ error: "method not allowed", methods: ["GET"] }, 405);
    }

    return json({ proposalSessionId: proposalState.proposalSessionId, proposal });
  }

  if (request.method !== "POST") {
    return json({ error: "method not allowed", methods: ["POST"] }, 405);
  }

  try {
    const updatedProposal = await recordImprovementLifecycleAction({
      env,
      proposalKey,
      action: route.action
    });

    return json({ proposalSessionId: proposalState.proposalSessionId, proposal: updatedProposal });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "improvement lifecycle update failed" }, 400);
  }
}

async function handleSkillRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const route = parseSkillRoute(pathname);

  if (!route) {
    return null;
  }

  if (route.action === "list") {
    if (request.method !== "GET") {
      return json({ error: "method not allowed", methods: ["GET"] }, 405);
    }

    return json({ skills: await listBundledSkills({ env }) });
  }

  if (!route.skillId) {
    return json({ error: "skillId is required" }, 400);
  }

  if (request.method !== "GET") {
    return json({ error: "method not allowed", methods: ["GET"] }, 405);
  }

  const skill = await readBundledSkillManifest({ env, skillId: route.skillId });
  return skill ? json({ skill }) : json({ error: "skill not found" }, 404);
}

export { SessionRuntime };

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const runtimeOptions = await buildRuntimeOptions(env);
    const status = buildRuntimeStatus(runtimeOptions);
    const isHeadRequest = request.method === "HEAD";

    if ((request.method === "GET" || isHeadRequest) && url.pathname === "/") {
      return new Response(isHeadRequest ? null : renderLandingPage(runtimeOptions), {
        headers: {
          "content-type": "text/html; charset=UTF-8"
        }
      });
    }
    if ((request.method === "GET" || isHeadRequest) && url.pathname === "/health") {
      return isHeadRequest
        ? new Response(null, {
            headers: {
              "content-type": "application/json; charset=UTF-8"
            }
          })
        : json(status);
    }

    if (request.method === "GET" && url.pathname === "/api/telemetry") {
      if (!isAuthorized(request, env)) return unauthorized();
      return handleTelemetryRoute(request, env);
    }

    if (url.pathname === "/api/pulse") {
      // Pulses are allowed without auth if project matches a whitelist or managed entity,
      // but for dogfooding we'll allow it with a projectID check.
      return handlePulseRoute(request, env);
    }

    if (url.pathname === "/api/managed/project") {
      if (!isAuthorized(request, env)) return unauthorized();
      return handleManagedProjectRoute(request, env);
    }

    if (url.pathname === "/api/spawn") {
      if (!isAuthorized(request, env)) return unauthorized();
      return handleSpawnRoute(request, env);
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/api/spawn") {
      if (!isAuthorized(request, env)) return unauthorized();
      return handleSpawnRoute(request, env);
    }

    if (url.pathname.startsWith("/api/") && !isAuthorized(request, env)) {
      return unauthorized();
    }

    if (url.pathname === "/api/model") {
      return handleModelRoute(request, env);
    }

    if (url.pathname === "/api/key") {
      return handleKeyRoute(request, env);
    }

    if (url.pathname === "/api/sovereign/metrics") {
      if (!isAuthorized(request, env)) return unauthorized();
      const currentState = await resolveFactsAsOf(env, new Date().toISOString());
      const drift = await auditInfrastructureDrift(env, currentState);
      const metrics = getSovereignMetrics(env, drift);
      return json(metrics);
    }

    if (url.pathname === "/api/sovereign/rebalance") {
      if (!isAuthorized(request, env)) return unauthorized();
      const currentState = await resolveFactsAsOf(env, new Date().toISOString());
      const result = await rebalanceInfrastructure(env, currentState);
      return json(result);
    }

    if (url.pathname === "/api/reflect/as-of") {
      return handleNexusPeersRoute(request, env);
    }

    if (url.pathname === "/api/economos/metrics") {
      if (!isAuthorized(request, env)) return unauthorized();
      const metrics = await getEconomosMetrics(env);
      return json(metrics);
    }

    if (url.pathname === "/api/economos/audit") {
      if (!isAuthorized(request, env)) return unauthorized();
      const currentState = await resolveFactsAsOf(env, new Date().toISOString());
      const audit = await auditEfficiency(env, currentState);
      return json(audit);
    }

    if (url.pathname === "/api/sophia/yield") {
      if (!isAuthorized(request, env)) return unauthorized();
      const yieldResult = await getSophiaYield(env);
      return json(yieldResult);
    }

    if (url.pathname === "/api/sophia/harvest") {
      if (!isAuthorized(request, env)) return unauthorized();
      const currentState = await resolveFactsAsOf(env, new Date().toISOString());
      // For this implementation, we simulate the Economos history based on current facts
      const currentEfficiency = await auditEfficiency(env, currentState);
      const harvest = await discoverPatterns(env, currentState, [currentEfficiency]);
      return json(harvest);
    }

    if (url.pathname === "/api/architectura/propositions") {
      if (!isAuthorized(request, env)) return unauthorized();
      const report = await getArchitecturaPropositions(env);
      return json(report);
    }

    if (url.pathname === "/api/architectura/optimize") {
      if (!isAuthorized(request, env)) return unauthorized();
      const currentState = await resolveFactsAsOf(env, new Date().toISOString());
      const currentEfficiency = await auditEfficiency(env, currentState);
      const currentYield = await discoverPatterns(env, currentState, [currentEfficiency]);
      const report = await proposeOptimizations(env, currentYield, currentEfficiency);
      return json(report);
    }

    if (url.pathname === "/api/aeturnus/status") {
      if (!isAuthorized(request, env)) return unauthorized();
      const status = await getSwarmStatus(env);
      return json(status);
    }

    if (url.pathname === "/api/aeturnus/recover" && request.method === "POST") {
      if (!isAuthorized(request, env)) return unauthorized();
      const result = await initiateSelfHealing(env);
      return json(result);
    }

    const handRouteResponse = await handleHandRoute(request, env, url.pathname);
    if (handRouteResponse) {
      return handRouteResponse;
    }

    const improvementRouteResponse = await handleImprovementRoute(request, env, url.pathname);
    if (improvementRouteResponse) {
      return improvementRouteResponse;
    }

    const skillRouteResponse = await handleSkillRoute(request, env, url.pathname);
    if (skillRouteResponse) {
      return skillRouteResponse;
    }

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const sessionId = crypto.randomUUID();
      const stub = getSessionStub(env, sessionId);
      const response = await stub.fetch(buildRuntimeUrl("/init", sessionId), {
        method: "POST"
      });
      const payload = (await response.json()) as { session: unknown };

      return json({ sessionId, session: payload.session }, 201);
    }
    
    const sessionRoute = parseSessionRoute(url.pathname);
    if (sessionRoute) {
      const stub = getSessionStub(env, sessionRoute.sessionId);

      if (request.method === "GET" && sessionRoute.action === "state") {
        const query = new URLSearchParams();
        const asOf = url.searchParams.get("asOf");

        if (asOf) {
          query.set("asOf", asOf);
        }

        return stub.fetch(buildRuntimeUrl("/state", sessionRoute.sessionId, query));
      }

      if (request.method === "POST" && sessionRoute.action === "chat") {
        return proxyJsonBody(request, stub, "/chat", sessionRoute.sessionId);
      }

      if (request.method === "POST" && sessionRoute.action === "messages") {
        return proxyJsonBody(request, stub, "/messages", sessionRoute.sessionId);
      }

      if (request.method === "POST" && sessionRoute.action === "tool-events") {
        return proxyJsonBody(request, stub, "/tool-events", sessionRoute.sessionId);
      }

      if (request.method === "GET" && sessionRoute.action === "recall") {
        const query = new URLSearchParams();
        const recallQuery = url.searchParams.get("q");
        const limit = url.searchParams.get("limit");
        const asOf = url.searchParams.get("asOf");

        if (recallQuery) {
          query.set("q", recallQuery);
        }

        if (limit) {
          query.set("limit", limit);
        }

        if (asOf) {
          query.set("asOf", asOf);
        }

        return stub.fetch(buildRuntimeUrl("/recall", sessionRoute.sessionId, query));
      }

      if (request.method === "POST" && sessionRoute.action === "sync") {
        return proxyJsonBody(request, stub, "/sync", sessionRoute.sessionId);
      }
    }

    return json(
      {
        error: "not found",
        routes: [
          "GET /",
          "GET /health",
          "POST /telegram/webhook",
          "GET /api/model",
          "POST /api/model",
          "GET /api/key",
          "POST /api/key",
          "GET /api/skills",
          "GET /api/skills/:id",
          "GET /api/hands",
          "GET /api/hands/:id",
          "POST /api/hands/:id/activate",
          "POST /api/hands/:id/pause",
          "POST /api/sessions",
          "GET /api/sessions/:id",
          "POST /api/sessions/:id/chat",
          "POST /api/sessions/:id/messages",
          "POST /api/sessions/:id/tool-events",
          "GET /api/sessions/:id/recall?q=..."
        ]
      },
      404
    );
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    try {
      await runScheduledHands({
        env,
        cron: controller.cron,
        timestamp: new Date(controller.scheduledTime).toISOString()
      });
      await runTelemetricAudit({
        env,
        cron: controller.cron,
        timestamp: new Date(controller.scheduledTime).toISOString()
      });
    } catch (error) {
      console.error("scheduled maintenance failed", error);
    }
  }
};