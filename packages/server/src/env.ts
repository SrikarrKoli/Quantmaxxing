export interface Env {
  DB: D1Database;
  ROOM: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  TOKEN_SECRET: string;
  FIREBASE_PROJECT_ID: string;
  ALLOWED_ORIGINS: string;
  AUTH_EMULATOR?: string;
  DISABLE_RATE_LIMITS?: string;
}
