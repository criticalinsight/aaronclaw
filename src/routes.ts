import { buildAaronDbEdgeSubstrateStatus } from "./aarondb-edge-substrate";

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
      "GET /api/sessions/:id/recall?q=..."
    ]
  } as const;
}

export function extractSessionId(pathname: string): string | null {
  return parseSessionRoute(pathname)?.sessionId ?? null;
}

export function parseSessionRoute(pathname: string): {
  sessionId: string;
  action: "state" | "chat" | "messages" | "tool-events" | "recall";
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
    action !== "recall"
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
  action: "list" | "detail" | "activate" | "pause";
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

  if (parts.length === 4 && (parts[3] === "activate" || parts[3] === "pause")) {
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

export function renderLandingPage(options: BootstrapStatusOptions = {}): string {
  const status = buildBootstrapStatus(options);
  const bootstrap = JSON.stringify(status).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${status.service}</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
      body { margin: 0; background: #111827; color: #e5e7eb; }
      main { max-width: 1100px; margin: 0 auto; padding: 24px; display: grid; gap: 16px; }
      h1, h2, h3, p { margin: 0; }
      .card { background: #1f2937; border: 1px solid #374151; border-radius: 16px; padding: 16px; }
      .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
      label { display: grid; gap: 6px; font-size: 14px; }
      input, textarea, button { border-radius: 10px; border: 1px solid #4b5563; background: #0f172a; color: inherit; padding: 10px 12px; font: inherit; }
      textarea { min-height: 120px; resize: vertical; }
      button { background: #2563eb; border-color: #2563eb; cursor: pointer; }
      button.secondary { background: transparent; }
      button:disabled { opacity: 0.6; cursor: wait; }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .session-meta, .status { font-size: 14px; color: #cbd5e1; }
      .stack { display: grid; gap: 12px; }
      .operator-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
      .operator-card { display: grid; gap: 10px; border: 1px solid #374151; border-radius: 12px; padding: 12px; background: #111827; }
      .section-header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
      .muted { font-size: 14px; color: #94a3b8; }
      .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 10px; background: #0f172a; border: 1px solid #4b5563; font-size: 12px; }
      .pill.active, .pill.ready, .pill.succeeded { border-color: #10b981; color: #6ee7b7; }
      .pill.paused, .pill.missing-secrets, .pill.failed { border-color: #f59e0b; color: #fbbf24; }
      .detail-list, .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: 14px; color: #cbd5e1; }
      details { border-top: 1px solid #374151; padding-top: 10px; }
      details summary { cursor: pointer; color: #93c5fd; }
      .messages { display: grid; gap: 12px; min-height: 260px; }
      .message { border: 1px solid #374151; border-radius: 12px; padding: 12px; background: #111827; }
      .message.user { border-color: #2563eb; }
      .message.assistant { border-color: #10b981; }
      .message-header { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; color: #93c5fd; margin-bottom: 8px; }
      .message.assistant .message-header { color: #6ee7b7; }
      .empty { color: #94a3b8; font-style: italic; }
      code { background: #0b1120; padding: 2px 6px; border-radius: 6px; }
      .hidden { display: none; }
    </style>
  </head>
  <body>
    <main>
      <section class="card">
        <h1>${status.service}</h1>
        <p>A browser-first Cloudflare Worker control surface backed by Durable Objects and AaronDB-style D1 facts.</p>
        <div class="session-meta">
          <div>Baseline: <code>${status.baseline}</code></div>
          <div>Assistant default: <code>${status.assistantRuntime}</code>${status.defaultModel ? ` / <code>${status.defaultModel}</code>` : ""}</div>
          ${
            status.activeAssistantRuntime !== status.assistantRuntime || status.activeModel !== status.defaultModel
              ? `<div>Current active path: <code>${status.activeAssistantRuntime}</code>${status.activeModel ? ` / <code>${status.activeModel}</code>` : ""}</div>`
              : ""
          }
          <div>Auth mode: <code>${status.authMode}</code></div>
        </div>
      </section>

      <section class="card grid">
        <label class="${status.authMode === "none" ? "hidden" : ""}">
          Deployment token
          <input id="auth-token" type="password" placeholder="Bearer token for this deployment" autocomplete="current-password" />
        </label>
        <label>
          Session ID
          <input id="session-id" type="text" placeholder="Create a new session or load an existing one" />
        </label>
        <div class="actions">
          <button id="create-session" type="button">Create session</button>
          <button id="load-session" type="button" class="secondary">Load session</button>
          <button id="reload-session" type="button" class="secondary">Reload state</button>
        </div>
      </section>

      <section class="card stack">
        <div class="section-header">
          <div class="stack">
            <h2>Operator controls</h2>
            <p class="muted">Protected hands and skills controls reuse the existing bearer-token surface. Enter the deployment token when auth is enabled, then refresh to inspect or operate bundled hands safely.</p>
          </div>
          <div class="actions">
            <button id="refresh-operators" type="button" class="secondary">Refresh operator data</button>
          </div>
        </div>
        <div class="operator-grid">
          <section class="stack">
            <h3>Hands</h3>
            <div id="hands" class="stack">
              <div class="empty">Load operator data to inspect hands.</div>
            </div>
          </section>
          <section class="stack">
            <h3>Skills</h3>
            <div id="skills" class="stack">
              <div class="empty">Load operator data to inspect skills.</div>
            </div>
          </section>
        </div>
      </section>

      <section class="card">
        <h2>Conversation</h2>
        <div id="session-meta" class="session-meta"></div>
        <div id="messages" class="messages">
          <div class="empty">Create or load a session to begin chatting.</div>
        </div>
      </section>

      <section class="card">
        <form id="composer">
          <label>
            Prompt
            <textarea id="prompt" placeholder="Ask the assistant something..."></textarea>
          </label>
          <div class="actions">
            <button id="send-message" type="submit">Send</button>
          </div>
        </form>
      </section>

      <section class="card">
        <h2>Runtime status</h2>
        <pre id="status" class="status"></pre>
      </section>
    </main>

    <script type="module">
      const bootstrap = ${bootstrap};
      const authStorageKey = "aaronclaw.auth-token";
      const sessionInput = document.querySelector("#session-id");
      const tokenInput = document.querySelector("#auth-token");
      const promptInput = document.querySelector("#prompt");
      const statusElement = document.querySelector("#status");
      const handsElement = document.querySelector("#hands");
      const skillsElement = document.querySelector("#skills");
      const messagesElement = document.querySelector("#messages");
      const sessionMetaElement = document.querySelector("#session-meta");
      const createButton = document.querySelector("#create-session");
      const loadButton = document.querySelector("#load-session");
      const reloadButton = document.querySelector("#reload-session");
      const refreshOperatorsButton = document.querySelector("#refresh-operators");
      const sendButton = document.querySelector("#send-message");
      const composer = document.querySelector("#composer");
      const state = {
        busy: false,
        hands: [],
        session: null,
        sessionId: new URL(window.location.href).searchParams.get("session") || "",
        skills: []
      };

      if (tokenInput) {
        tokenInput.value = window.localStorage.getItem(authStorageKey) || "";
      }

      sessionInput.value = state.sessionId;
      renderStatus("Ready");
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

      handsElement.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }

        const button = target.closest("button[data-hand-id][data-hand-action]");
        if (!(button instanceof HTMLButtonElement)) {
          return;
        }

        const handId = button.dataset.handId;
        const action = button.dataset.handAction;
        if (!handId || (action !== "activate" && action !== "pause")) {
          return;
        }

        run(() => setHandLifecycle(handId, action));
      });

      void initialize();

      async function run(action) {
        if (state.busy) {
          return;
        }

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
        if (state.sessionId) {
          await run(loadSession);
        }

        if (bootstrap.authMode === "none" || (tokenInput && tokenInput.value.trim())) {
          await run(refreshOperatorData);
        }
      }

      async function createSession() {
        const payload = await apiFetch("/api/sessions", { method: "POST" });
        state.session = payload.session;
        setSessionId(payload.sessionId);
        renderSession();
        renderStatus("Created session " + payload.sessionId);
      }

      async function loadSession() {
        const sessionId = sessionInput.value.trim();
        if (!sessionId) {
          throw new Error("Enter a session ID to load.");
        }

        const payload = await apiFetch("/api/sessions/" + encodeURIComponent(sessionId));
        state.session = payload.session;
        setSessionId(sessionId);
        renderSession();
        renderStatus("Loaded session " + sessionId);
      }

      async function reloadSession() {
        if (!state.sessionId) {
          throw new Error("Create or load a session first.");
        }

        const payload = await apiFetch(
          "/api/sessions/" + encodeURIComponent(state.sessionId)
        );
        state.session = payload.session;
        renderSession();
        renderStatus("Reloaded persisted state for " + state.sessionId);
      }

      async function sendMessage() {
        if (!state.sessionId) {
          throw new Error("Create or load a session before sending a prompt.");
        }

        const content = promptInput.value.trim();
        if (!content) {
          throw new Error("Enter a prompt before sending.");
        }

        const payload = await apiFetch(
          "/api/sessions/" + encodeURIComponent(state.sessionId) + "/chat",
          {
            method: "POST",
            body: JSON.stringify({ content })
          }
        );

        state.session = payload.session;
        promptInput.value = "";
        renderSession();
        const sourceLabel =
          payload.assistant.source === "workers-ai"
            ? "Workers AI"
            : payload.assistant.source === "gemini"
              ? "Gemini"
              : "fallback";
        renderStatus(
          "Received " + sourceLabel + " response for " + state.sessionId
        );
      }

      async function refreshOperatorData() {
        const [handsPayload, skillsPayload] = await Promise.all([
          apiFetch("/api/hands"),
          apiFetch("/api/skills")
        ]);

        state.hands = Array.isArray(handsPayload.hands) ? handsPayload.hands : [];
        state.skills = Array.isArray(skillsPayload.skills) ? skillsPayload.skills : [];
        renderOperators();
        renderStatus(
          "Refreshed operator data for " + state.hands.length + " hand(s) and " + state.skills.length + " skill(s)."
        );
      }

      async function setHandLifecycle(handId, action) {
        await apiFetch("/api/hands/" + encodeURIComponent(handId) + "/" + action, {
          method: "POST"
        });
        await refreshOperatorData();
        renderStatus((action === "activate" ? "Activated " : "Paused ") + handId + " through the protected operator surface.");
      }

      async function apiFetch(path, init = {}) {
        const headers = new Headers(init.headers || {});
        headers.set("content-type", headers.get("content-type") || "application/json");

        if (tokenInput && tokenInput.value.trim()) {
          const token = tokenInput.value.trim();
          headers.set("authorization", "Bearer " + token);
          window.localStorage.setItem(authStorageKey, token);
        }

        const response = await fetch(path, { ...init, headers });
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(payload.error || "Request failed with " + response.status);
        }

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
          sessionMetaElement.textContent = "No session loaded yet.";
          messagesElement.innerHTML = '<div class="empty">Create or load a session to begin chatting.</div>';
          return;
        }

        sessionMetaElement.textContent =
          "Session " +
          session.id +
          " • " +
          session.events.length +
          " events • last tx " +
          session.lastTx +
          " • last active " +
          session.lastActiveAt;

        if (!session.events.length) {
          messagesElement.innerHTML = '<div class="empty">This session exists, but it has no messages yet.</div>';
          return;
        }

        messagesElement.innerHTML = session.events
          .map((event) => {
            const role = event.kind === "message" ? event.role : "tool";
            const body =
              event.kind === "message"
                ? event.content
                : event.toolName + ": " + event.summary;
            const source =
              event.metadata && typeof event.metadata.source === "string"
                ? " • " + event.metadata.source
                : "";

            return [
              '<article class="message ' + escapeHtml(role) + '">',
              '  <div class="message-header">',
              '    <span>' + escapeHtml(role) + escapeHtml(source) + '</span>',
              '    <span>tx ' +
                escapeHtml(String(event.tx)) +
                ' • ' +
                escapeHtml(event.createdAt) +
                '</span>',
              "  </div>",
              '  <div>' + escapeHtml(body).replace(/\\n/g, "<br />") + '</div>',
              "</article>"
            ].join("");
          })
          .join("");
      }

      function renderOperators() {
        renderHands();
        renderSkills();
      }

      function renderHands() {
        if (!state.hands.length) {
          handsElement.innerHTML =
            '<div class="empty">' +
            escapeHtml(
              bootstrap.authMode === "bearer-token" && (!tokenInput || !tokenInput.value.trim())
                ? "Enter the deployment token, then refresh operator data to inspect hands."
                : "No hand data loaded yet. Use refresh operator data to inspect the bundled hands runtime."
            ) +
            "</div>";
          return;
        }

        handsElement.innerHTML = state.hands
          .map((hand) => {
            const recentRuns = Array.isArray(hand.recentRuns) ? hand.recentRuns : [];
            const recentAudit = Array.isArray(hand.recentAudit) ? hand.recentAudit : [];
            const latestRun = hand.latestRun;

            return [
              '<article class="operator-card">',
              '  <div class="section-header">',
              '    <div class="stack">',
              '      <strong>' + escapeHtml(hand.label) + '</strong>',
              '      <span class="muted">' + escapeHtml(hand.description) + '</span>',
              "    </div>",
              '    <span class="pill ' + escapeHtml(hand.status) + '">' + escapeHtml(hand.status) + '</span>',
              "  </div>",
              '  <ul class="detail-list">',
              '    <li><strong>ID:</strong> <code>' + escapeHtml(hand.id) + '</code></li>',
              '    <li><strong>Runtime:</strong> <code>' + escapeHtml(hand.runtime) + '</code></li>',
              '    <li><strong>Schedules:</strong> ' + escapeHtml((hand.scheduleCrons || []).join(", ") || "none") + '</li>',
              '    <li><strong>Last lifecycle:</strong> ' + escapeHtml(hand.lastLifecycleAction || "none") + '</li>',
              '    <li><strong>Updated:</strong> ' + escapeHtml(hand.updatedAt || "never") + '</li>',
              '    <li><strong>Latest run:</strong> ' + escapeHtml(latestRun ? latestRun.status + (latestRun.cron ? " via " + latestRun.cron : "") : "no runs yet") + '</li>',
              "  </ul>",
              '  <div class="actions">',
              '    <button type="button" data-hand-id="' + escapeHtml(hand.id) + '" data-hand-action="activate"' + (hand.status === "active" ? " disabled" : "") + '>Activate</button>',
              '    <button type="button" class="secondary" data-hand-id="' + escapeHtml(hand.id) + '" data-hand-action="pause"' + (hand.status === "paused" ? " disabled" : "") + '>Pause</button>',
              "  </div>",
              renderHandRuns(recentRuns),
              renderHandAudit(recentAudit),
              "</article>"
            ].join("");
          })
          .join("");
      }

      function renderHandRuns(recentRuns) {
        return [
          '<details>',
          '  <summary>Recent status</summary>',
          recentRuns.length
            ? '  <ul class="list">' +
                recentRuns
                  .map((run) =>
                    '<li><span class="pill ' +
                    escapeHtml(run.status) +
                    '">' +
                    escapeHtml(run.status) +
                    '</span> ' +
                    escapeHtml(run.summary) +
                    (run.maintenanceSessionId
                      ? ' <span class="muted">(' + escapeHtml(run.maintenanceSessionId) + ")</span>"
                      : "") +
                    '</li>'
                  )
                  .join("") +
                "</ul>"
            : '  <div class="empty">No hand runs recorded yet.</div>',
          "</details>"
        ].join("");
      }

      function renderHandAudit(recentAudit) {
        return [
          '<details>',
          '  <summary>Recent audit</summary>',
          recentAudit.length
            ? '  <ul class="list">' +
                recentAudit
                  .map((audit) =>
                    '<li><span class="pill ' +
                    escapeHtml(audit.outcome || "") +
                    '">' +
                    escapeHtml(audit.outcome || "unknown") +
                    '</span> ' +
                    escapeHtml(audit.toolName) +
                    (audit.capability ? ' <code>' + escapeHtml(audit.capability) + '</code>' : "") +
                    (audit.detail ? ' <span class="muted">' + escapeHtml(audit.detail) + '</span>' : "") +
                    '</li>'
                  )
                  .join("") +
                "</ul>"
            : '  <div class="empty">No hand audit records recorded yet.</div>',
          "</details>"
        ].join("");
      }

      function renderSkills() {
        if (!state.skills.length) {
          skillsElement.innerHTML =
            '<div class="empty">' +
            escapeHtml(
              bootstrap.authMode === "bearer-token" && (!tokenInput || !tokenInput.value.trim())
                ? "Enter the deployment token, then refresh operator data to inspect skills."
                : "No skill data loaded yet. Use refresh operator data to inspect the manifest-driven skill set."
            ) +
            "</div>";
          return;
        }

        skillsElement.innerHTML = state.skills
          .map((skill) => {
            const declaredToolDetails = Array.isArray(skill.declaredToolDetails)
              ? skill.declaredToolDetails
              : [];
            const requiredSecrets = Array.isArray(skill.requiredSecrets) ? skill.requiredSecrets : [];

            return [
              '<article class="operator-card">',
              '  <div class="section-header">',
              '    <div class="stack">',
              '      <strong>' + escapeHtml(skill.label) + '</strong>',
              '      <span class="muted">' + escapeHtml(skill.description) + '</span>',
              "    </div>",
              '    <span class="pill ' + escapeHtml(skill.readiness) + '">' + escapeHtml(skill.readiness) + '</span>',
              "  </div>",
              '  <ul class="detail-list">',
              '    <li><strong>ID:</strong> <code>' + escapeHtml(skill.id) + '</code></li>',
              '    <li><strong>Memory scope:</strong> ' + escapeHtml(skill.memoryScope) + '</li>',
              '    <li><strong>Runtime:</strong> <code>' + escapeHtml(skill.runtime) + '</code></li>',
              '    <li><strong>Install scope:</strong> <code>' + escapeHtml(skill.installScope) + '</code></li>',
              "  </ul>",
              '<details>',
              '  <summary>Declared tools and capability policy</summary>',
              declaredToolDetails.length
                ? '  <ul class="list">' +
                    declaredToolDetails
                      .map((tool) =>
                        '<li><strong>' +
                        escapeHtml(tool.id) +
                        '</strong> <code>' +
                        escapeHtml(tool.capability) +
                        '</code> <span class="muted">' +
                        escapeHtml(tool.policy) +
                        '</span></li>'
                      )
                      .join("") +
                    "</ul>"
                : '  <div class="empty">No declared tools.</div>',
              '</details>',
              '<details>',
              '  <summary>Required secrets</summary>',
              requiredSecrets.length
                ? '  <ul class="list">' +
                    requiredSecrets
                      .map((secret) =>
                        '<li><span class="pill ' +
                        escapeHtml(secret.configured ? "ready" : "missing-secrets") +
                        '">' +
                        escapeHtml(secret.configured ? "configured" : "missing") +
                        '</span> ' +
                        escapeHtml(secret.id) +
                        (secret.validationStatus
                          ? ' <span class="muted">' + escapeHtml(secret.validationStatus) + '</span>'
                          : "") +
                        '</li>'
                      )
                      .join("") +
                    "</ul>"
                : '  <div class="empty">This skill does not require extra secrets.</div>',
              '</details>',
              "</article>"
            ].join("");
          })
          .join("");
      }

      function renderStatus(message, isError = false) {
        statusElement.textContent = JSON.stringify(
          {
            level: isError ? "error" : "info",
            message,
            sessionId: state.sessionId || null,
            handCount: state.hands.length,
            skillCount: state.skills.length,
            authMode: bootstrap.authMode,
            assistantRuntime: bootstrap.assistantRuntime,
            defaultModel: bootstrap.defaultModel,
            activeAssistantRuntime: bootstrap.activeAssistantRuntime,
            activeModel: bootstrap.activeModel,
            selectionFallbackReason: bootstrap.selectionFallbackReason
          },
          null,
          2
        );
      }

      function setBusy(busy) {
        state.busy = busy;
        [createButton, loadButton, reloadButton, refreshOperatorsButton, sendButton].forEach((button) => {
          button.disabled = busy;
        });
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
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