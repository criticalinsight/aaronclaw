import type { JsonObject } from "./session-state";

export interface WranglerConfig {
  name: string;
  main: string;
  compatibility_date: string;
  usage_model?: "bundled" | "unbound";
}

/**
 * 🧙🏾‍♂️ Rich Hickey: De-complect identity from transport.
 * Supports both scoped API tokens and legacy Global Keys.
 */
function getAuthHeaders(credentials: { token?: string; email?: string; key?: string }): Record<string, string> {
  if (credentials.token) {
    return {
      Authorization: `Bearer ${credentials.token}`
    };
  }
  if (credentials.email && credentials.key) {
    return {
      "X-Auth-Email": credentials.email,
      "X-Auth-Key": credentials.key
    };
  }
  throw new Error("Missing Cloudflare credentials: provide either CLOUDFLARE_API_TOKEN or both CLOUDFLARE_EMAIL and CLOUDFLARE_API_KEY.");
}

export async function orchestrateCloudflareDeployment(): Promise<{
  message: string;
  deploymentCount: number;
  secretCount: number;
}> {
  // Entry point from session-runtime.ts
  return {
    message: "Cloudflare orchestration engine initialized.",
    deploymentCount: 0,
    secretCount: 0
  };
}

export async function createCloudflareWorker(
  credentials: { token?: string; email?: string; key?: string },
  accountId: string,
  config: WranglerConfig,
  scriptContent: string
): Promise<JsonObject> {
  // Use the Cloudflare API to create/update a Worker script
  // 🧙🏾‍♂️ Rich Hickey: Simplify deployment by pushing the bundled script directly.
  
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${config.name}`, {
    method: "PUT",
    headers: {
      ...getAuthHeaders(credentials),
      "Content-Type": "application/javascript"
    },
    body: scriptContent
  });

  if (!response.ok) {
    const errorPayload = await response.json() as any;
    const errorMsg = errorPayload.errors?.map((e: any) => e.message).join(', ') || errorPayload.message || response.statusText;
    throw new Error(`Cloudflare Worker Deployment Failed: ${errorMsg}`);
  }

  const result = await response.json() as JsonObject;

  // 🧙🏾‍♂️ Rich Hickey: Simplify routing. Ensure the worker is actually reachable.
  const subdomainResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${config.name}/subdomain`, {
    method: "POST",
    headers: {
      ...getAuthHeaders(credentials),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ enabled: true })
  });

  if (!subdomainResponse.ok) {
    console.warn(`Failed to enable workers.dev subdomain for ${config.name}, it might need manual routing.`);
  }

  return result;
}

export async function putCloudflareSecret(
  credentials: { token?: string; email?: string; key?: string },
  accountId: string,
  workerName: string,
  secretName: string,
  secretValue: string
): Promise<JsonObject> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/secrets`, {
    method: "PUT",
    headers: {
      ...getAuthHeaders(credentials),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: secretName,
      text: secretValue,
      type: "secret_text"
    })
  });

  if (!response.ok) {
    const error = await response.json() as any;
    throw new Error(`Cloudflare Secret Injection Failed: ${error.message || response.statusText}`);
  }

  return await response.json() as JsonObject;
}

/**
 * 🧙🏾‍♂️ Rich Hickey: De-complect content from transport.
 * Synthesizes a minimalist single-file Worker that serves a static file map.
 */
export function synthesizeServingWorker(files: { path: string; content: string }[]): string {
  const fileMap = JSON.stringify(Object.fromEntries(files.map(f => [f.path, f.content])));
  return `
    const FILES = ${fileMap};
    addEventListener('fetch', event => {
      event.respondWith(handleRequest(event.request));
    });
    async function handleRequest(request) {
      const url = new URL(request.url);
      let path = url.pathname.slice(1) || 'index.html';
      let content = FILES[path];
      
      // Fallback for directory paths (e.g. /about -> about.html)
      if (!content && !path.includes('.')) {
        content = FILES[path + '.html'];
      }

      if (!content) return new Response('Not Found', { status: 404 });
      
      const type = path.endsWith('.html') ? 'text/html' : 
                   path.endsWith('.css') ? 'text/css' : 
                   path.endsWith('.js') ? 'application/javascript' :
                   path.endsWith('.json') ? 'application/json' :
                   'text/plain';
                   
      return new Response(content, { headers: { 'content-type': type } });
    }
  `;
}

export async function deploySimpleSite(
  credentials: { token?: string; email?: string; key?: string },
  accountId: string,
  siteName: string,
  files: { path: string; content: string }[]
): Promise<JsonObject> {
  const workerScript = synthesizeServingWorker(files);
  return createCloudflareWorker(
    credentials,
    accountId,
    {
      name: siteName,
      main: "worker.js",
      compatibility_date: "2026-03-13"
    },
    workerScript
  );
}
