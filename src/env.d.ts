interface WorkersAiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface WorkersAiBinding {
  run(
    model: string,
    input: {
      messages: WorkersAiMessage[];
      max_tokens?: number;
      temperature?: number;
    }
  ): Promise<unknown>;
}

interface Env {
  AARONDB: D1Database;
  AI?: WorkersAiBinding;
  AI_MODEL?: string;
  APP_AUTH_TOKEN?: string;
  SESSION_RUNTIME: DurableObjectNamespace;
}
