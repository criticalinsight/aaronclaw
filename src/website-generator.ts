import { generateAssistantReply, AssistantProviderRoute } from "./assistant";
import { type GithubFileChange } from "./github-coordinator";
import { resolveModelSelection } from "./model-registry";
import { AaronDbEdgeSessionRepository } from "./session-state";

/**
 * 🧙🏾‍♂️ Rich Hickey: Synthesis as a pure function of prompt and model.
 * Takes a natural language prompt and returns a set of files for a website.
 */
export async function generateWebsiteContent(
  env: Pick<Env, "AI" | "AI_MODEL" | "GEMINI_API_KEY" | "AARONDB">,
  prompt: string,
  sessionId?: string
): Promise<GithubFileChange[]> {
  // 1. Prepare systematic prompt for website generation
  const systemPrompt = `
    You are a Master Anemone-Schematic Architect 🧙🏾‍♂️.
    
    CRITICAL: You must output ONLY a valid, complete JSON object.
    Do NOT truncate your output. Do NOT include markdown wrappers.
    
    Strict Aesthetic Baseline (Anemone Fidelity):
    1. Grid: body { display: grid; grid-template-columns: 1fr min(47rem, 90%) 1fr; grid-row-gap: 1rem; }
    2. Framing: body > * { grid-column: 2; }
    3. Typography: font-family: Consolas, Menlo, Monaco, monospace;
    4. Markers: 
       - h1::before, h2::before, h3::before { content: '# '; color: var(--accent); }
       - ul li::marker { content: '» '; color: var(--accent); }
    5. Navigation: Minimalist flex header. Links format: " / home / ", " / journal / ".
    6. Colors: background: #0a0e14; accent: #3182ce; surface: rgba(18, 24, 32, 0.8) with backdrop-filter: blur(10px).
    
    Required Files:
    - index.html: Semantic structure with <nav>, <main>, and <footer>.
    - style.css: COMPLETE implementation of the above rules. Use CSS Variables.
    - script.js: Micro-interactions for the "premium" feel.
    
    Example Output:
    {
      "index.html": "<!doctype html>...",
      "style.css": ":root { --bg: #0a0e14; --accent: #3182ce; } body { ... } h1::before { ... }",
      "script.js": "..."
    }
  `;

  // ... (resolveModelSelection logic remains same)
  const selection = resolveModelSelection(env, "gemini:gemini-3.1-pro-preview");
  const activeModel = selection.activeModel;
  
  if (!activeModel) {
    throw new Error("No usable LLM model found for website generation.");
  }

  const route: AssistantProviderRoute = {
    provider: activeModel.provider,
    model: activeModel.model,
    apiKey: activeModel.provider === "gemini" ? env.GEMINI_API_KEY : null
  };

  // 🧙🏾‍♂️ Load existing session if sessionId is provided
  const targetSessionId = sessionId || "website-factory-tmp";
  const repository = new AaronDbEdgeSessionRepository(env.AARONDB, targetSessionId);
  const existingSession = await repository.getSession();

  const reply = await generateAssistantReply({
    env: env as any,
    session: existingSession || { 
        id: targetSessionId, 
        createdAt: new Date().toISOString(),
        messages: [], 
        events: [], 
        toolEvents: [],
        lastActiveAt: new Date().toISOString(), 
        lastTx: 0, 
        persistence: "aarondb-edge",
        memorySource: "aarondb-edge",
        recallableMemoryCount: 0
    },
    sessionId: targetSessionId,
    userMessage: prompt,
    recallMatches: [],
    knowledgeVaultMatches: [],
    primaryRoute: route,
    promptAdditions: [systemPrompt]
  });

  // 🧙🏾‍♂️ If the reply is a fallback, we shouldn't attempt to parse JSON.
  if (reply.source === "fallback") {
    throw new Error(`Synthesis Failed: ${reply.fallbackReason} - ${reply.fallbackDetail}`);
  }

  const content = reply.content.trim();

  // 1. Try to extract JSON from markdown code blocks
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const potentialJson = codeBlockMatch ? codeBlockMatch[1].trim() : content;

  try {
    const fileMap = JSON.parse(potentialJson.replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
    
    if (typeof fileMap === "object" && fileMap !== null) {
        return Object.entries(fileMap).map(([path, content]) => ({
          path,
          content: String(content)
        }));
    }
  } catch (e) {
    // 2. Fallback: If it looks like raw HTML, treat it as index.html
    if (content.toLowerCase().includes("<html") || content.toLowerCase().includes("<!doctype html")) {
        console.warn("LLM returned raw HTML instead of JSON. Falling back to single-file mode.");
        return [{
            path: "index.html",
            content: content
        }];
    }
    
    throw new Error(`Failed to parse LLM website generation response. It must be a JSON file map. Raw reply started with: ${content.slice(0, 100)}`);
  }

  throw new Error("LLM did not return a valid file map or recognizable HTML.");
}
