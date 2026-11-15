export interface Env {
  DB: D1Database;
  ROOM: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  TOKEN_SECRET: string;
  FIREBASE_PROJECT_ID: string;
  ALLOWED_ORIGINS: string;
  AUTH_EMULATOR?: string;
  DISABLE_RATE_LIMITS?: string;
  /** Wait before a lone queued player gets a bot; "0" turns bot fill off. */
  BOT_FILL_CASUAL_MS?: string;
  BOT_FILL_RANKED_MS?: string;
}
