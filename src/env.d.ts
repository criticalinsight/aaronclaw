interface WorkersAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }[];
  tool_call_id?: string;
}

interface WorkersAiBinding {
  run(
    model: string,
    input: {
      messages?: WorkersAiMessage[];
      text?: string | string[];
      tools?: {
        type: "function";
        function: {
          name: string;
          description: string;
          parameters: any;
        };
      }[];
      max_tokens?: number;
      temperature?: number;
    }
  ): Promise<any>;
}

interface Env {
  AARONDB: D1Database;
  AARONDB_STATE?: DurableObjectNamespace;
  ARCHIVE?: R2Bucket;
  GEMINI_API_KEY: string;
  AI: WorkersAiBinding;
  AI_MODEL: string;
  APP_AUTH_TOKEN: string;
  CONFIG_KV?: KVNamespace;
  DB?: D1Database;
  SESSION_RUNTIME: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ADMIN_CHAT_ID?: string | number;
  TELEGRAM_WEBHOOK_SECRET?: string;
  GITHUB_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_EMAIL?: string;
  CLOUDFLARE_API_KEY?: string;
  RECOVERY_TRIGGER_TOKEN?: string;
  VECTOR_INDEX?: VectorizeIndex;
}
