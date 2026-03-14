import { buildAaronDbEdgeSubstrateStatus } from "./aarondb-edge-substrate";
import { discoverResources, generateWranglerConfig } from "./wiring-engine";
import { createGithubRepository, pushFilesToGithub, setupGithubActions } from "./github-coordinator";

export interface Env {
  AARONDB: D1Database;
  GITHUB_TOKEN: string;
}

interface BootstrapStatusOptions {
  authRequired?: boolean;
  defaultProvider?: "workers-ai" | "gemini" | null;
  defaultModel?: string | null;
  activeProvider?: "workers-ai" | "gemini" | null;
  activeModel?: string | null;
  selectionFallbackReason?: string | null;
  hasAiBinding?: boolean;
}

export function buildBootstrapStatus(options: BootstrapStatusOptions = {}) {
  const substrateStatus = buildAaronDbEdgeSubstrateStatus();
  const defaultProvider = options.defaultProvider ?? null;
  const activeProvider = options.activeProvider ?? null;
  const assistantRuntime = defaultProvider ?? "deterministic-fallback";
  const activeAssistantRuntime = activeProvider ?? "deterministic-fallback";

  return {
    service: "aaronclaw",
    controlSurface: "browser-first",
    runtime: "cloudflare-worker",
    durableObjectBinding: "SESSION_RUNTIME",
    durableSourceOfTruth: "D1 immutable fact log + Durable Object hot projection",
    baseline: "cloudflare/moltworker",
    reuseBoundary: "control-surface and gateway patterns only",
    excludedRuntime: "cloudflare sandbox containers",
    memorySource: "aarondb-edge",
    skillRuntime: "manifest-driven",
    skillInstallScope: "bundled-local-only",
    toolPolicyRuntime: "capability-gated",
    toolAuditHistory: "structured-session-and-hand-history",
    ...substrateStatus,
    authMode: options.authRequired ? "bearer-token" : "none",
    authBoundary: options.authRequired
      ? "Landing page stays public for token entry; all /api/* routes require Authorization: Bearer <APP_AUTH_TOKEN>."
      : "No bearer token is configured; this personal deployment is effectively open.",
    assistantRuntime,
    assistantBindingStatus: activeProvider ? "configured" : "missing",
    assistantFallbackBehavior: buildAssistantFallbackBehavior({
      defaultProvider,
      activeProvider,
      activeModel: options.activeModel,
      hasAiBinding: options.hasAiBinding,
      selectionFallbackReason: options.selectionFallbackReason
    }),
    activeAssistantRuntime,
    defaultProvider,
    defaultModel: options.defaultModel ?? null,
    activeProvider,
    activeModel: options.activeModel ?? null,
    selectionFallbackReason: options.selectionFallbackReason ?? null,
    operatorRoutes: [
      "GET /api/model",
      "POST /api/model",
      "GET /api/key",
      "POST /api/key",
      "GET /api/improvements",
      "GET /api/improvements/:proposalKey",
      "POST /api/improvements/:proposalKey/approve",
      "POST /api/improvements/:proposalKey/reject",
      "POST /api/improvements/:proposalKey/pause",
      "GET /api/skills",
      "GET /api/skills/:id",
      "GET /api/hands",
      "GET /api/hands/:id",
      "POST /api/hands/:id/activate",
      "POST /api/hands/:id/pause"
    ],
    sessionRoutes: [
      "POST /api/sessions",
      "GET /api/sessions/:id",
      "POST /api/sessions/:id/chat",
      "POST /api/sessions/:id/messages",
      "POST /api/sessions/:id/tool-events",
      "GET /api/sessions/:id/recall?q=...",
      "POST /api/sessions/:id/sync"
    ],
    adminRoutes: [
      "GET /api/telemetry",
      "POST /api/spawn",
      "GET /api/nexus/peers",
      "POST /api/nexus/peers"
    ]
  } as const;
}

export function extractSessionId(pathname: string): string | null {
  return parseSessionRoute(pathname)?.sessionId ?? null;
}

export function parseSessionRoute(pathname: string): {
  sessionId: string;
  action: "state" | "chat" | "messages" | "tool-events" | "recall" | "sync";
} | null {
  const parts = pathname.split("/").filter(Boolean);

  if (parts.length < 3 || parts.length > 4) {
    return null;
  }

  if (parts[0] !== "api" || parts[1] !== "sessions" || !parts[2]) {
    return null;
  }

  const action = parts[3] ?? "state";

  if (
    action !== "state" &&
    action !== "chat" &&
    action !== "messages" &&
    action !== "tool-events" &&
    action !== "recall" &&
    action !== "sync"
  ) {
    return null;
  }

  return {
    sessionId: parts[2],
    action
  };
}

export function parseHandRoute(pathname: string): {
  handId: string | null;
  action: "list" | "detail" | "activate" | "pause" | "run";
} | null {
  const parts = pathname.split("/").filter(Boolean);

  if (parts[0] !== "api" || parts[1] !== "hands") {
    return null;
  }

  if (parts.length === 2) {
    return {
      handId: null,
      action: "list"
    };
  }

  if (!parts[2]) {
    return null;
  }

  if (parts.length === 3) {
    return {
      handId: parts[2],
      action: "detail"
    };
  }

  if (
    parts.length === 4 &&
    (parts[3] === "activate" || parts[3] === "pause" || parts[3] === "run")
  ) {
    return {
      handId: parts[2],
      action: parts[3]
    };
  }

  return null;
}

export function parseSkillRoute(pathname: string): {
  skillId: string | null;
  action: "list" | "detail";
} | null {
  const parts = pathname.split("/").filter(Boolean);

  if (parts[0] !== "api" || parts[1] !== "skills") {
    return null;
  }

  if (parts.length === 2) {
    return {
      skillId: null,
      action: "list"
    };
  }

  if (parts.length === 3 && parts[2]) {
    return {
      skillId: parts[2],
      action: "detail"
    };
  }

  return null;
}

export function parseImprovementRoute(pathname: string): {
  proposalKey: string | null;
  action: "list" | "detail" | "approve" | "reject" | "pause" | "promote" | "rollback";
} | null {
  const parts = pathname.split("/").filter(Boolean);

  if (parts[0] !== "api" || parts[1] !== "improvements") {
    return null;
  }

  if (parts.length === 2) {
    return {
      proposalKey: null,
      action: "list"
    };
  }

  const proposalKey = decodePathSegment(parts[2]);
  if (!proposalKey) {
    return null;
  }

  if (parts.length === 3) {
    return {
      proposalKey,
      action: "detail"
    };
  }

  if (
    parts.length === 4 &&
    (parts[3] === "approve" ||
      parts[3] === "reject" ||
      parts[3] === "pause" ||
      parts[3] === "promote" ||
      parts[3] === "rollback")
  ) {
    return {
      proposalKey,
      action: parts[3]
    };
  }

  return null;
}

export function renderLandingPage(options: BootstrapStatusOptions = {}): string {
  const status = buildBootstrapStatus(options);
  const bootstrap = JSON.stringify(status).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${status.service} // Mission Control</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
    <style>
      :root {
        --bg: #0b0f1a;
        --panel-bg: rgba(20, 26, 42, 0.7);
        --accent: #2dd4bf; /* Bioluminescent Teal */
        --accent-glow: rgba(45, 212, 191, 0.2);
        --text: #f1f5f9;
        --muted: #94a3b8;
        --border: rgba(45, 212, 191, 0.15);
        --danger: #ef4444;
        --success: #10b981;
        --warning: #f59e0b;
        --font-mono: 'JetBrains Mono', monospace;
        --font-sans: 'Inter', sans-serif;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: var(--font-sans);
        line-height: 1.5;
        overflow-x: hidden;
        background-image: 
          radial-gradient(circle at 50% 50%, rgba(45, 212, 191, 0.05) 0%, transparent 50%),
          linear-gradient(rgba(45, 212, 191, 0.02) 1px, transparent 1px),
          linear-gradient(90deg, rgba(45, 212, 191, 0.02) 1px, transparent 1px);
        background-size: 100% 100%, 40px 40px, 40px 40px;
      }

      header {
        padding: 24px;
        border-bottom: 1px solid var(--border);
        background: rgba(11, 15, 26, 0.8);
        backdrop-filter: blur(8px);
        position: sticky;
        top: 0;
        z-index: 100;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .logo {
        display: flex;
        align-items: center;
        gap: 12px;
        font-family: var(--font-mono);
        letter-spacing: -0.02em;
      }

      .logo h1 {
        font-size: 20px;
        margin: 0;
        font-weight: 700;
        background: linear-gradient(90deg, var(--accent), #94a3b8);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      .nav-links {
        display: flex;
        gap: 20px;
        font-size: 13px;
        font-family: var(--font-mono);
      }

      .nav-links a {
        color: var(--muted);
        text-decoration: none;
        transition: color 0.2s;
      }

      .nav-links a:hover { color: var(--accent); }

      main {
        max-width: 1400px;
        margin: 0 auto;
        padding: 24px;
        display: grid;
        gap: 24px;
        grid-template-columns: 320px 1fr 320px;
      }

      @media (max-width: 1100px) {
        main { grid-template-columns: 1fr; }
        aside { display: none; }
      }

      .panel {
        background: var(--panel-bg);
        border: 1px solid var(--border);
        border-radius: 12px;
        backdrop-filter: blur(12px);
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      h2, h3 {
        font-family: var(--font-mono);
        font-size: 14px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--accent);
        margin: 0;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      h2::before {
        content: '';
        width: 4px;
        height: 12px;
        background: var(--accent);
        display: inline-block;
      }

      .sidebar { display: flex; flex-direction: column; gap: 24px; }

      .card {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 8px;
        padding: 12px;
        font-size: 13px;
        transition: all 0.2s;
      }

      .card:hover {
        border-color: var(--accent);
        box-shadow: 0 0 15px var(--accent-glow);
      }

      .terminal {
        background: #05070a;
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 16px;
        font-family: var(--font-mono);
        font-size: 13px;
        height: 600px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 12px;
        position: relative;
      }

      .terminal::after {
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        background: linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.2) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.06), rgba(0, 255, 0, 0.02), rgba(0, 0, 255, 0.06));
        background-size: 100% 2px, 3px 100%;
        pointer-events: none;
        opacity: 0.3;
      }

      .message {
        padding-left: 12px;
        border-left: 2px solid var(--muted);
      }

      .message.user { border-left-color: var(--accent); }
      .message.assistant { border-left-color: var(--success); }
      .message.tool { border-left-color: var(--warning); opacity: 0.8; }

      .message-meta {
        font-size: 11px;
        color: var(--muted);
        margin-bottom: 4px;
      }

      .composer {
        display: grid;
        gap: 12px;
      }

      textarea {
        background: #05070a;
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--text);
        padding: 12px;
        font-family: var(--font-mono);
        font-size: 13px;
        resize: none;
        height: 100px;
        outline: none;
      }

      textarea:focus { border-color: var(--accent); box-shadow: 0 0 10px var(--accent-glow); }

      .actions { display: flex; gap: 12px; }

      button {
        background: transparent;
        border: 1px solid var(--accent);
        color: var(--accent);
        padding: 8px 16px;
        border-radius: 6px;
        font-family: var(--font-mono);
        font-size: 12px;
        text-transform: uppercase;
        cursor: pointer;
        transition: all 0.2s;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      button:hover:not(:disabled) {
        background: var(--accent);
        color: var(--bg);
        box-shadow: 0 0 15px var(--accent-glow);
      }

      button.secondary { border-color: var(--muted); color: var(--muted); }
      button.secondary:hover:not(:disabled) { background: var(--muted); color: var(--bg); }

      button:disabled { opacity: 0.5; cursor: not-allowed; }

      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        font-family: var(--font-mono);
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid var(--border);
      }

      .pill { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
      .active .pill, .ready .pill, .success .pill { background: var(--success); box-shadow: 0 0 8px var(--success); animation: pulse 2s infinite; }
      .paused .pill, .warning .pill { background: var(--warning); }
      .failed .pill, .error .pill { background: var(--danger); }

      @keyframes pulse {
        0% { opacity: 1; }
        50% { opacity: 0.4; }
        100% { opacity: 1; }
      }

      .meta-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; font-size: 11px; color: var(--muted); }
      .meta-grid label { color: var(--accent); font-family: var(--font-mono); text-transform: uppercase; font-size: 10px; margin-bottom: 2px; display: block; }

      input {
        background: #05070a;
        border: 1px solid var(--border);
        border-radius: 4px;
        color: var(--text);
        padding: 6px 8px;
        font-family: var(--font-mono);
        font-size: 12px;
        width: 100%;
        outline: none;
      }

      pre {
        margin: 0;
        background: #05070a;
        padding: 12px;
        border-radius: 8px;
        font-size: 10px;
        color: #6ee7b7;
        overflow-x: auto;
        border: 1px solid var(--border);
      }

      .hidden { display: none; }
      .empty { font-style: italic; color: var(--muted); text-align: center; margin-top: 20px; }

      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-track { background: var(--bg); }
      ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
      ::-webkit-scrollbar-thumb:hover { background: var(--accent); }
            .terminal-container {
                flex: 2;
                font-family: 'JetBrains Mono', monospace;
                font-size: 0.8rem;
                display: flex;
                flex-direction: column;
            }

            .terminal-box {
                background: rgba(0, 0, 0, 0.4);
                padding: 10px;
                border-radius: 4px;
                border: 1px solid var(--border);
                height: 200px;
                overflow-y: auto;
                box-shadow: inset 0 0 10px rgba(0, 255, 157, 0.05);
            }

            .terminal-line {
                margin-bottom: 4px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .timestamp { color: var(--accent); opacity: 0.7; }
            .attr { color: #88ffcc; font-weight: bold; }
            .muted { opacity: 0.5; }

            .led.active {
                background: var(--accent);
                box-shadow: 0 0 15px var(--accent);
                animation: pulse 2s infinite ease-in-out;
            }

            @keyframes pulse {
                0% { opacity: 0.4; transform: scale(0.9); }
                50% { opacity: 1; transform: scale(1.1); }
                100% { opacity: 0.4; transform: scale(0.9); }
            }

            .quick-actions {
                display: flex;
                gap: 15px;
                margin-top: 20px;
            }

            .btn {
                background: var(--accent);
                color: var(--background);
                border: none;
                padding: 10px 20px;
                font-family: 'Inter', sans-serif;
                font-weight: 700;
                border-radius: 4px;
                cursor: pointer;
                text-transform: uppercase;
                letter-spacing: 1px;
                transition: transform 0.2s, box-shadow 0.2s;
            }

            .btn:hover {
                transform: translateY(-2px);
                box-shadow: 0 5px 15px rgba(0, 255, 157, 0.4);
            }

            .btn.secondary {
                background: transparent;
                border: 1px solid var(--accent);
                color: var(--accent);
            }
        </style>
  </head>
  <body>
    <header>
      <div class="logo">
        <h1>AARONCLAW 🧙🏾‍♂️</h1>
      </div>
      <nav class="nav-links">
        <a href="https://docs.aaronclaw.workers.dev" target="_blank">DOCS</a>
        <a href="https://docs.aaronclaw.workers.dev/roadmap.html" target="_blank">ROADMAP</a>
        <a href="https://github.com/criticalinsight/aaronclaw" target="_blank">GITHUB</a>
      </nav>
    </header>

    <main>
      <aside class="sidebar">
        <section class="panel">
          <h2>Identity</h2>
          <div class="meta-grid">
            <div>
              <label>Service</label>
              <code>${status.service}</code>
            </div>
            <div>
              <label>Runtime</label>
              <code>${status.runtime}</code>
            </div>
            <div>
              <label>Default AI</label>
              <code>${status.assistantRuntime}</code>
            </div>
            <div>
              <label>Auth</label>
              <code>${status.authMode}</code>
            </div>
          </div>
          <p style="font-size: 11px; color: var(--muted); margin: 0;">${status.durableSourceOfTruth}</p>
        </section>

        <section class="panel">
          <h2>Terminal Sync</h2>
          <div class="stack" style="display: grid; gap: 12px;">
            <label class="${status.authMode === "none" ? "hidden" : ""}">
              <span style="font-size: 11px; color: var(--accent); font-family: var(--font-mono);">BEARER_TOKEN</span>
              <input id="auth-token" type="password" placeholder="••••••••" autocomplete="current-password" />
            </label>
            <label>
              <span style="font-size: 11px; color: var(--accent); font-family: var(--font-mono);">SESSION_ID</span>
              <input id="session-id" type="text" placeholder="UUID or 'latest'" />
            </label>
            <div class="actions" style="flex-direction: column;">
              <button id="create-session" type="button">INIT NEW SESSION</button>
              <button id="load-session" type="button" class="secondary">MOUNT SESSION</button>
            </div>
          </div>
        </section>

        <section class="panel">
          <h2>Substrate Status</h2>
          <pre id="status">${JSON.stringify(status, null, 2)}</pre>
          <button id="reload-session" type="button" class="secondary" style="width: 100%; margin-top: 8px;">REFRESH SIGNAL</button>
        </section>
      </aside>

      <section class="panel" style="gap: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <h2>Mission Control</h2>
          <div id="session-meta" style="font-size: 11px; font-family: var(--font-mono); color: var(--muted);"></div>
        </div>
        
        <div id="messages" class="terminal">
          <div class="empty">INITIATING CONTROL SURFACE...</div>
        </div>

        <form id="composer" class="composer">
          <textarea id="prompt" placeholder="PROMPT > _"></textarea>
          <div class="actions">
            <button id="send-message" type="submit" style="background: var(--accent); color: var(--bg); font-weight: 700;">TRANSMIT SIGNAL</button>
          </div>
        </form>
      </section>

      <aside class="sidebar">
        <section class="panel">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h2>Hands</h2>
            <button id="refresh-operators" type="button" class="secondary" style="padding: 2px 8px; font-size: 10px;">POLL</button>
          </div>
          <div id="hands" class="sidebar-list" style="display: grid; gap: 12px;">
            <div class="empty">NO HANDS SCANNING</div>
          </div>
        </section>

        <section class="panel">
          <h2>Skills</h2>
          <div id="skills" class="sidebar-list" style="display: grid; gap: 12px;">
            <div class="empty">NO SKILLS MOUNTED</div>
          </div>
        </section>

        <section class="panel">
          <h2>Improvements</h2>
          <div id="improvements" class="sidebar-list" style="display: grid; gap: 12px;">
            <div class="empty">STABLE STATE</div>
          </div>
        </section>

        <section class="panel">
          <div class="card terminal-container">
              <div class="card-header">
                  <span class="led active" id="pulse-led"></span>
                  <h3>Tactical Audit Stream</h3>
              </div>
              <div id="audit-terminal" class="terminal-box">
                  <div class="terminal-line muted">Initializing neural link...</div>
                  <div class="terminal-line muted">Substrate connection: ACTIVE</div>
              </div>
          </div>
        </section>

        <section class="panel">
          <h2>Spawn New Agent</h2>
          <form id="spawn-form" class="stack" style="display: grid; gap: 12px;">
            <label>
              <span style="font-size: 11px; color: var(--accent); font-family: var(--font-mono);">AGENT_NAME</span>
              <input id="spawn-name" type="text" placeholder="my-new-agent" required />
            </label>
            <label>
              <span style="font-size: 11px; color: var(--accent); font-family: var(--font-mono);">AGENT_PROMPT</span>
              <textarea id="spawn-prompt" placeholder="A simple Cloudflare Worker that..." rows="3"></textarea>
            </label>
            <button id="spawn-agent" type="submit" style="background: var(--accent); color: var(--bg); font-weight: 700;">SPAWN AGENT</button>
          </form>
        </section>
      </aside>
    </main>

    <script type="module">
      const bootstrap = ${bootstrap};
      const authStorageKey = "aaronclaw.auth-token";
      const sessionInput = document.querySelector("#session-id");
      const tokenInput = document.querySelector("#auth-token");
      const promptInput = document.querySelector("#prompt");
      const statusElement = document.querySelector("#status");
      const handsElement = document.querySelector("#hands");
      const improvementsElement = document.querySelector("#improvements");
      const skillsElement = document.querySelector("#skills");
      const messagesElement = document.querySelector("#messages");
      const sessionMetaElement = document.querySelector("#session-meta");
      const createButton = document.querySelector("#create-session");
      const loadButton = document.querySelector("#load-session");
      const reloadButton = document.querySelector("#reload-session");
      const refreshOperatorsButton = document.querySelector("#refresh-operators");
      const sendButton = document.querySelector("#send-message");
      const composer = document.querySelector("#composer");
      const spawnForm = document.querySelector("#spawn-form");
      const spawnNameInput = document.querySelector("#spawn-name");
      const spawnPromptInput = document.querySelector("#spawn-prompt");
      const spawnAgentButton = document.querySelector("#spawn-agent");
      
      const state = {
        busy: false,
        hands: [],
        improvements: [],
        session: null,
        sessionId: new URL(window.location.href).searchParams.get("session") || "",
        skills: []
      };

      if (tokenInput) {
        tokenInput.value = window.localStorage.getItem(authStorageKey) || "";
      }

      sessionInput.value = state.sessionId;
      renderStatus("System Ready");
      renderOperators();
      renderSession();

      createButton.addEventListener("click", () => run(createSession));
      loadButton.addEventListener("click", () => run(loadSession));
      reloadButton.addEventListener("click", () => run(reloadSession));
      refreshOperatorsButton.addEventListener("click", () => run(refreshOperatorData));
      composer.addEventListener("submit", (event) => {
        event.preventDefault();
        run(sendMessage);
      });
      spawnForm.addEventListener("submit", (event) => {
        event.preventDefault();
        run(spawnAgent);
      });

      handsElement.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest("button[data-hand-id][data-hand-action]");
        if (!(button instanceof HTMLButtonElement)) return;
        const handId = button.dataset.handId;
        const action = button.dataset.handAction;
        if (!handId || (action !== "activate" && action !== "pause")) return;
        run(() => setHandLifecycle(handId, action));
      });

      improvementsElement.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest("button[data-proposal-key][data-improvement-action]");
        if (!(button instanceof HTMLButtonElement)) return;
        const proposalKey = button.dataset.proposalKey;
        const action = button.dataset.improvementAction;
        if (!proposalKey || (action !== "approve" && action !== "reject" && action !== "pause")) return;
        run(() => setImprovementLifecycle(proposalKey, action));
      });

      void initialize();

      async function run(action) {
        if (state.busy) return;
        setBusy(true);
        try {
          await action();
        } catch (error) {
          renderStatus(error instanceof Error ? error.message : String(error), true);
        } finally {
          setBusy(false);
        }
      }

      async function initialize() {
        if (state.sessionId) await run(loadSession);
        if (bootstrap.authMode === "none" || (tokenInput && tokenInput.value.trim())) {
          await run(refreshOperatorData);
          void startTelemetryLoop();
        }
      }

      async function createSession() {
        const payload = await apiFetch("/api/sessions", { method: "POST" });
        state.session = payload.session;
        setSessionId(payload.sessionId);
        renderSession();
        renderStatus("New Interface Created: " + payload.sessionId);
      }

      async function loadSession() {
        const sessionId = sessionInput.value.trim();
        if (!sessionId) throw new Error("Enter UUID");
        const payload = await apiFetch("/api/sessions/" + encodeURIComponent(sessionId));
        state.session = payload.session;
        setSessionId(sessionId);
        renderSession();
        renderStatus("Interface Mounted: " + sessionId);
      }

      async function reloadSession() {
        if (!state.sessionId) throw new Error("No Active Session");
        const payload = await apiFetch("/api/sessions/" + encodeURIComponent(state.sessionId));
        state.session = payload.session;
        renderSession();
        renderStatus("Signal Refreshed: " + state.sessionId);
      }

      async function sendMessage() {
        if (!state.sessionId) throw new Error("Mount Session First");
        const content = promptInput.value.trim();
        if (!content) throw new Error("Null Signal");
        const payload = await apiFetch("/api/sessions/" + encodeURIComponent(state.sessionId) + "/chat", {
          method: "POST",
          body: JSON.stringify({ content })
        });
        state.session = payload.session;
        promptInput.value = "";
        renderSession();
        renderStatus("Signal Received from " + (payload.assistant.source || "remote"));
      }

      async function refreshOperatorData() {
        const [handsPayload, skillsPayload, improvementsPayload] = await Promise.all([
          apiFetch("/api/hands"),
          apiFetch("/api/skills"),
          apiFetch("/api/improvements")
        ]);
        state.hands = handsPayload.hands || [];
        state.improvements = improvementsPayload.proposals || [];
        state.skills = skillsPayload.skills || [];
        renderOperators();
        renderStatus("Substrate Polled: " + state.hands.length + "H / " + state.skills.length + "S");
      }

      async function setHandLifecycle(handId, action) {
        await apiFetch("/api/hands/" + encodeURIComponent(handId) + "/" + action, { method: "POST" });
        await refreshOperatorData();
        renderStatus(action.toUpperCase() + ": " + handId);
      }

      async function setImprovementLifecycle(proposalKey, action) {
        await apiFetch("/api/improvements/" + encodeURIComponent(proposalKey) + "/" + action, { method: "POST" });
        await refreshOperatorData();
        renderStatus(action.toUpperCase() + ": " + proposalKey);
      }

      async function spawnAgent() {
        const name = spawnNameInput.value.trim();
        const prompt = spawnPromptInput.value.trim();
        if (!name) throw new Error("Agent name is required.");

        renderStatus("Spawning agent '" + name + "'...", false);
        try {
          const payload = await apiFetch("/api/spawn", {
            method: "POST",
            body: JSON.stringify({ name, prompt })
          });
          renderStatus("Agent '" + name + "' spawned! URL: " + payload.url);
          spawnNameInput.value = "";
          spawnPromptInput.value = "";
        } catch (error) {
          renderStatus("Failed to spawn agent: " + (error instanceof Error ? error.message : String(error)), true);
        }
      }

      async function startTelemetryLoop() {
        const pulseLed = document.querySelector("#pulse-led");
        const auditTerminal = document.querySelector("#audit-terminal");

        while (true) {
          try {
            const payload = await apiFetch("/api/telemetry");
            if (payload.facts && payload.facts.length > 0) {
              if (pulseLed) {
                pulseLed.style.background = "var(--accent)";
                setTimeout(() => { pulseLed.style.background = "#333"; }, 200);
              }
              
              if (auditTerminal) {
                const logs = payload.facts.map(f => {
                  const date = new Date(f.createdAt || Date.now()).toLocaleTimeString();
                  return "[" + date + "] " + f.entityId + ": " + f.factType + " -> " + JSON.stringify(f.factValue);
                }).join("\n");
                auditTerminal.textContent = logs + "\n---\n" + auditTerminal.textContent;
                if (auditTerminal.textContent.length > 10000) {
                  auditTerminal.textContent = auditTerminal.textContent.substring(0, 10000);
                }
              }
            }
          } catch (e) {
            console.error("Telemetry loop error:", e);
          }
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      async function apiFetch(path, init = {}) {
        const headers = new Headers(init.headers || {});
        headers.set("content-type", "application/json");
        if (tokenInput?.value.trim()) {
          const token = tokenInput.value.trim();
          headers.set("authorization", "Bearer " + token);
          window.localStorage.setItem(authStorageKey, token);
        }
        const response = await fetch(path, { ...init, headers });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "Signal Error " + response.status);
        return payload;
      }

      function setSessionId(sessionId) {
        state.sessionId = sessionId;
        sessionInput.value = sessionId;
        const url = new URL(window.location.href);
        url.searchParams.set("session", sessionId);
        window.history.replaceState({}, "", url);
      }

      function renderSession() {
        const session = state.session;
        if (!session) {
          messagesElement.innerHTML = '<div class="empty">AWAITING CONNECTION...</div>';
          return;
        }
        sessionMetaElement.textContent = "ID: " + session.id + " // " + session.events.length + " EVENTS";
        if (!session.events.length) {
          messagesElement.innerHTML = '<div class="empty">VOID SESSION. TRANSMIT SIGNAL TO BEGIN.</div>';
          return;
        }
        messagesElement.innerHTML = session.events
          .map((event) => {
            const role = event.kind === "message" ? event.role : "tool";
            const body = event.kind === "message" ? event.content : (event.toolName + ": " + (event.summary || "executing"));
            const source = event.metadata?.source ? " // " + event.metadata.source : "";
            return \`
              <article class="message \${role}">
                <div class="message-meta">\${role.toUpperCase()}\${source.toUpperCase()} // TX \${event.tx} // \${event.createdAt}</div>
                <div style="white-space: pre-wrap;">\${escapeHtml(body)}</div>
              </article>
            \`;
          }).join("");
        messagesElement.scrollTop = messagesElement.scrollHeight;
      }

      function renderOperators() {
        renderHands();
        renderImprovements();
        renderSkills();
      }

      function renderHands() {
        if (!state.hands.length) {
          handsElement.innerHTML = '<div class="empty">NO HANDS SCANNING</div>';
          return;
        }
        handsElement.innerHTML = state.hands.map(hand => \`
          <article class="card active">
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
              <strong style="color: var(--accent);">\${escapeHtml(hand.label)}</strong>
              <div class="status-pill \${hand.status}"><div class="pill"></div>\${hand.status.toUpperCase()}</div>
            </div>
            <div style="font-size: 11px; opacity: 0.7; font-family: var(--font-mono);">\${escapeHtml(hand.id)}</div>
            <div class="actions" style="margin-top: 10px;">
              <button class="secondary" style="font-size: 9px; padding: 2px 6px;" data-hand-id="\${hand.id}" data-hand-action="activate" \${hand.status === 'active' ? 'disabled' : ''}>ACTIVATE</button>
              <button class="secondary" style="font-size: 9px; padding: 2px 6px;" data-hand-id="\${hand.id}" data-hand-action="pause" \${hand.status === 'paused' ? 'disabled' : ''}>PAUSE</button>
            </div>
          </article>
        \`).join("");
      }

      function renderImprovements() {
        if (!state.improvements.length) {
          improvementsElement.innerHTML = '<div class="empty">STABLE STATE</div>';
          return;
        }
        improvementsElement.innerHTML = state.improvements.map(prop => \`
          <article class="card activity">
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
              <strong style="color: #ffcc88;">\${escapeHtml(prop.attribute)}</strong>
              <div class="status-pill \${prop.status}"><div class="pill"></div>\${prop.status.toUpperCase()}</div>
            </div>
            <div style="font-size: 11px; opacity: 0.7; font-family: var(--font-mono);">\${escapeHtml(prop.entity)}</div>
            <div class="actions" style="margin-top: 10px;">
              <button class="secondary" style="font-size: 9px; padding: 2px 6px;" data-improvement-key="\${prop.entity}:\${prop.attribute}" data-improvement-action="apply" \${prop.status === 'applied' ? 'disabled' : ''}>APPLY</button>
              <button class="secondary" style="font-size: 9px; padding: 2px 6px;" data-improvement-key="\${prop.entity}:\${prop.attribute}" data-improvement-action="discard" \${prop.status === 'discarded' ? 'disabled' : ''}>DISCARD</button>
            </div>
          </article>
        \`).join("");
      }

      function renderSkills() {
        if (!state.skills.length) {
          skillsElement.innerHTML = '<div class="empty">NO SKILLS MOUNTED</div>';
          return;
        }
        skillsElement.innerHTML = state.skills.map(skill => \`
          <article class="card">
            <div style="color: var(--accent); font-weight: bold; margin-bottom: 4px;">\${escapeHtml(skill.id)}</div>
            <div style="font-size: 0.75rem; opacity: 0.8; line-height: 1.4;">\${escapeHtml(skill.description)}</div>
          </article>
        \`).join("");
      }

      function renderStatus(message, isError = false) {
        statusElement.textContent = JSON.stringify({
          level: isError ? "ERROR" : "SIGNAL",
          message,
          timestamp: new Date().toISOString(),
          activeModel: bootstrap.activeModel
        }, null, 2);
      }

      function setBusy(busy) {
        state.busy = busy;
        [createButton, loadButton, reloadButton, refreshOperatorsButton, sendButton].forEach(b => { 
          if(b) b.disabled = busy; 
        });
      }

      function escapeHtml(v) {
        return String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
      }
    </script>
  </body>
</html>`;
}

function buildAssistantFallbackBehavior(input: {
  defaultProvider: "workers-ai" | "gemini" | null;
  activeProvider: "workers-ai" | "gemini" | null;
  activeModel?: string | null;
  hasAiBinding?: boolean;
  selectionFallbackReason?: string | null;
}): string {
  if (!input.activeProvider) {
    return "No selectable model path is currently available; deterministic fallback handles every assistant reply.";
  }

  if (input.defaultProvider === "gemini" && input.activeProvider === "gemini") {
    return "Gemini is the default active model path. If Gemini is unavailable, AaronClaw falls back to Workers AI when available before deterministic fallback.";
  }

  if (input.defaultProvider === "gemini" && input.activeProvider === "workers-ai") {
    const fallbackDetail = input.selectionFallbackReason
      ? ` Current fallback reason: ${input.selectionFallbackReason}.`
      : "";
    return `Gemini remains the default operator-facing model path, but Workers AI${input.activeModel ? ` (${input.activeModel})` : ""} is currently the active safe fallback because the Gemini route is not selectable.${fallbackDetail} If the active model call fails or returns empty, the Worker logs the reason and sends a deterministic fallback reply.`;
  }

  if (input.activeProvider === "workers-ai") {
    return input.hasAiBinding
      ? "Workers AI is the active assistant path. If the model call fails or returns empty, the Worker logs the reason and sends a deterministic fallback reply."
      : "Workers AI is selected but its binding is not configured, so deterministic fallback handles replies.";
  }

  return "Gemini is the active assistant path. If Gemini is unavailable, AaronClaw falls back to deterministic reply behavior.";
}

function decodePathSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.length ? decoded : null;
  } catch {
    return null;
  }
}