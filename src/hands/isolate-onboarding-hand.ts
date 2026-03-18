import { JsonObject } from "../session-state";
import { getGithubFile, pushFilesToGithub } from "../github-coordinator";
import { tool, generateText, zodSchema } from "ai";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { SovereignExecutor } from "../sovereign-executor";
import { z } from "zod";
import { createAnthropic } from '@ai-sdk/anthropic';

/**
 * isolate-onboarding-hand
 * 🧙🏾‍♂️ Phase 24: Sovereign Autonomous Onboarding.
 * Uses @cloudflare/codemode to orchestrate telemetry injection and registration.
 */
export async function runIsolateOnboardingHand(env: any, input: { projectId: string, repoUrl: string }): Promise<JsonObject> {
  console.log(`🚀 Isolate Onboarding Hand (Code Mode): Onboarding ${input.projectId}...`);

  const db = env.AARONDB;
  const githubToken = env.GITHUB_TOKEN;
  const anthropicApiKey = env.ANTHROPIC_API_KEY;
  
  if (!db || !githubToken || !anthropicApiKey) {
    return { status: "error", message: "AARONDB, GITHUB_TOKEN, or ANTHROPIC_API_KEY not found." };
  }

  const anthropic = createAnthropic({ apiKey: anthropicApiKey });

  try {
    const url = new URL(input.repoUrl);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const owner = pathParts[0];
    const repoRaw = pathParts[1];
    const repoClean = repoRaw.endsWith(".git") ? repoRaw.slice(0, -4) : repoRaw;

    // Define tools flatly for better type inference
    const getFile = tool({
      description: "Gets the content of a file from the repository.",
      inputSchema: zodSchema(z.object({ path: z.string() })),
      execute: async ({ path }: { path: string }) => {
        const file = await getGithubFile(githubToken, owner, repoClean, path);
        return file ? { content: file.content, sha: file.sha } : null;
      }
    });

    const pushFile = tool({
      description: "Pushes a new version of a file to the repository.",
      inputSchema: zodSchema(z.object({ path: z.string(), content: z.string(), message: z.string() })),
      execute: async ({ path, content, message }: { path: string, content: string, message: string }) => {
        return await pushFilesToGithub(githubToken, owner, repoClean, "main", [{ path, content }], message);
      }
    });

    const registerProject = tool({
      description: "Registers the project in AaronDB facts.",
      inputSchema: zodSchema(z.object({ 
        projectId: z.string(), 
        repoUrl: z.string(),
        metadata: z.record(z.string(), z.any()).optional()
      })),
      execute: async ({ projectId, repoUrl, metadata }: { projectId: string, repoUrl: string, metadata?: Record<string, any> }) => {
        const timestamp = new Date().toISOString();
        // In D1, we use JSON.stringify for values.
        const metadataJson = metadata ? JSON.stringify(metadata) : null;
        const fact = {
          session_id: "global:projects",
          entity: projectId,
          attribute: "type",
          value_json: JSON.stringify("managed-project"),
          tx_index: 0,
          occurred_at: timestamp,
          operation: "assert" as const
        };

        await db.prepare(
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

        // Store repoUrl fact
        await db.prepare(
          "INSERT INTO aarondb_facts (session_id, entity, attribute, value_json, tx, tx_index, occurred_at, operation) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(tx), 0) + 1 FROM aarondb_facts), ?, ?, ?)"
        ).bind(
          fact.session_id,
          fact.entity,
          "repoUrl",
          JSON.stringify(repoUrl),
          1,
          fact.occurred_at,
          fact.operation
        ).run();

        return { status: "registered", timestamp };
      }
    });

    const executor = new SovereignExecutor();
    const codeTool = createCodeTool({
      tools: {
        getFile,
        pushFile,
        registerProject
      } as any,
      executor
    });

    const telemetryCode = `
/**
 * 🧙🏾‍♂️ AaronClaw Telemetry Bridge
 */
export async function sendPulseToAaronClaw(projectId: string, metrics: Record<string, number | string>) {
  const url = typeof AARONCLAW_URL !== 'undefined' ? AARONCLAW_URL : (globalThis as any).AARONCLAW_URL;
  const token = typeof AARONCLAW_AUTH_TOKEN !== 'undefined' ? AARONCLAW_AUTH_TOKEN : (globalThis as any).AARONCLAW_AUTH_TOKEN;
  
  if (!url || !token) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": \`Bearer \${token}\`
      },
      body: JSON.stringify({
        projectId,
        metrics,
        timestamp: new Date().toISOString()
      })
    });
  } catch (e) {
    console.error("Failed to send pulse to AaronClaw", e);
  }
}
`;

    const { text, toolResults } = await generateText({
      model: anthropic('claude-3-5-sonnet-latest'),
      system: `You are the AaronClaw Onboarding Orchestrator. 
Your goal is to onboard project "${input.projectId}" (Repo: ${input.repoUrl}).

Rules:
1. Locate the entry point (heuristic: src/lib/aggregator.ts or src/aggregator.ts).
2. If the file exists, append the Telemetry Bridge code provided below.
3. Register the project in AaronDB using 'codemode.registerProject'.

Telemetry Bridge Code to append:
${telemetryCode}

You have a special 'execute_code' tool. use it to write a TypeScript script that performs these steps. 
The script has access to 'codemode' object with:
- codemode.getFile({ path: string })
- codemode.pushFile({ path: string, content: string, message: string })
- codemode.registerProject({ projectId: string, repoUrl: string })`,
      prompt: `Onboard project ${input.projectId}.`,
      tools: { execute_code: codeTool }
    });

    const codeResult = (toolResults as any[])?.find(r => r.toolName === 'execute_code')?.result;

    return {
      status: "success",
      message: text || "Onboarding orchestrated via Code Mode.",
      details: codeResult,
      orchestration: {
        text,
        steps: (toolResults || []).length
      }
    };

  } catch (error: any) {
    console.error("❌ Isolate Onboarding (Code Mode) failed:", error);
    return { status: "error", message: error.message };
  }
}
