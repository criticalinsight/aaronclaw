import {
  buildBootstrapStatus,
  parseSessionRoute,
  renderLandingPage
} from "./routes";
import { getConfiguredModel } from "./assistant";
import { SessionRuntime } from "./session-runtime";

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

  if (!expected) {
    return true;
  }

  const header = request.headers.get("authorization");
  return header === `Bearer ${expected}`;
}

function buildRuntimeOptions(env: Env) {
  return {
    authRequired: isAuthConfigured(env),
    defaultModel: getConfiguredModel(env),
    hasAiBinding: Boolean(env.AI)
  };
}

function buildRuntimeStatus(env: Env) {
  return buildBootstrapStatus({
    ...buildRuntimeOptions(env)
  });
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

export { SessionRuntime };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const runtimeOptions = buildRuntimeOptions(env);
    const status = buildRuntimeStatus(env);
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

    if (url.pathname.startsWith("/api/") && !isAuthorized(request, env)) {
      return unauthorized();
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
    }

    return json(
      {
        error: "not found",
        routes: [
          "GET /",
          "GET /health",
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
  }
};