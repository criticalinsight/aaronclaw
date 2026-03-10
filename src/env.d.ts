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
  AARONDB_STATE?: DurableObjectNamespace;
  ARCHIVE?: R2Bucket;
  GEMINI_API_KEY?: string;
  AI?: WorkersAiBinding;
  AI_MODEL?: string;
  APP_AUTH_TOKEN?: string;
  CONFIG_KV?: KVNamespace;
  DB?: D1Database;
  SESSION_RUNTIME: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  VECTOR_INDEX?: VectorizeIndex;
}
