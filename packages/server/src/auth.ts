import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import type { PlayerKind } from "@qm/shared";
import type { Env } from "./env";

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keyCache.set(secret, k);
  }
  return k;
}

export async function sign(payload: object, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export async function verify<T>(token: string | null | undefined, secret: string): Promise<T | null> {
  if (!token || token.length > 2048) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const payload = JSON.parse(dec.decode(fromB64url(body))) as T & { exp?: number };
    if (typeof payload.exp === "number" && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export interface GuestToken {
  typ: "guest";
  gid: string;
  name: string;
  exp: number;
}

/** Short-lived identity handed to a Durable Object over a WebSocket URL. */
export interface Ticket {
  typ: "ticket";
  key: string;
  kind: Exclude<PlayerKind, "bot">;
  name: string;
  uid?: string;
  rating?: number;
  exp: number;
}

export interface FirebaseIdentity {
  uid: string;
  email?: string;
  emailVerified: boolean;
  provider: string;
}

const JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);

export async function verifyFirebaseToken(token: string, env: Env): Promise<FirebaseIdentity | null> {
  try {
    let payload: Record<string, unknown>;
    if (env.AUTH_EMULATOR === "true") {
      // Emulator tokens are unsigned; only ever enabled for local development.
      payload = decodeJwt(token) as Record<string, unknown>;
      if (payload.aud !== env.FIREBASE_PROJECT_ID) return null;
    } else {
      const res = await jwtVerify(token, JWKS, {
        issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
        audience: env.FIREBASE_PROJECT_ID,
        algorithms: ["RS256"],
      });
      payload = res.payload as Record<string, unknown>;
    }
    const uid = typeof payload.sub === "string" ? payload.sub : null;
    if (!uid) return null;
    const fb = (payload.firebase ?? {}) as { sign_in_provider?: string };
    return {
      uid,
      email: typeof payload.email === "string" ? payload.email : undefined,
      emailVerified: payload.email_verified === true,
      provider: fb.sign_in_provider ?? "unknown",
    };
  } catch {
    return null;
  }
}

export function randomId(bytes = 12): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
