import { buildAaronDbEdgeSubstrateStatus } from "./aarondb-edge-substrate";

interface BootstrapStatusOptions {
  authRequired?: boolean;
  defaultModel?: string | null;
  hasAiBinding?: boolean;
}

export function buildBootstrapStatus(options: BootstrapStatusOptions = {}) {
  const substrateStatus = buildAaronDbEdgeSubstrateStatus();

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
    ...substrateStatus,
    authMode: options.authRequired ? "bearer-token" : "none",
    authBoundary: options.authRequired
      ? "Landing page stays public for token entry; all /api/* routes require Authorization: Bearer <APP_AUTH_TOKEN>."
      : "No bearer token is configured; this personal deployment is effectively open.",
    assistantRuntime: options.hasAiBinding ? "workers-ai" : "deterministic-fallback",
    assistantBindingStatus: options.hasAiBinding ? "configured" : "missing",
    assistantFallbackBehavior: options.hasAiBinding
      ? "Workers AI is configured as the primary runtime; if a model call fails or returns empty, the Worker logs the reason and sends a deterministic fallback reply."
      : "No AI binding is configured; deterministic fallback handles every assistant reply.",
    defaultModel: options.defaultModel ?? null,
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
          <div>Assistant runtime: <code>${status.assistantRuntime}</code>${status.defaultModel ? ` / <code>${status.defaultModel}</code>` : ""}</div>
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
      const messagesElement = document.querySelector("#messages");
      const sessionMetaElement = document.querySelector("#session-meta");
      const createButton = document.querySelector("#create-session");
      const loadButton = document.querySelector("#load-session");
      const reloadButton = document.querySelector("#reload-session");
      const sendButton = document.querySelector("#send-message");
      const composer = document.querySelector("#composer");
      const state = {
        busy: false,
        session: null,
        sessionId: new URL(window.location.href).searchParams.get("session") || ""
      };

      if (tokenInput) {
        tokenInput.value = window.localStorage.getItem(authStorageKey) || "";
      }

      sessionInput.value = state.sessionId;
      renderStatus("Ready");
      renderSession();

      createButton.addEventListener("click", () => run(createSession));
      loadButton.addEventListener("click", () => run(loadSession));
      reloadButton.addEventListener("click", () => run(reloadSession));
      composer.addEventListener("submit", (event) => {
        event.preventDefault();
        run(sendMessage);
      });

      if (state.sessionId) {
        run(loadSession);
      }

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
        renderStatus(
          "Received " +
            (payload.assistant.source === "workers-ai" ? "Workers AI" : "fallback") +
            " response for " +
            state.sessionId
        );
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

      function renderStatus(message, isError = false) {
        statusElement.textContent = JSON.stringify(
          {
            level: isError ? "error" : "info",
            message,
            sessionId: state.sessionId || null,
            authMode: bootstrap.authMode,
            assistantRuntime: bootstrap.assistantRuntime,
            defaultModel: bootstrap.defaultModel
          },
          null,
          2
        );
      }

      function setBusy(busy) {
        state.busy = busy;
        [createButton, loadButton, reloadButton, sendButton].forEach((button) => {
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