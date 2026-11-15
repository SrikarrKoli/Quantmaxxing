const ORIGIN = (import.meta.env.VITE_API_ORIGIN as string | undefined) || "";

export const OFFLINE = "You're offline. Solo practice still works without a connection.";
export const BUSY = "The game server is busy or at its daily limit (it resets at 00:00 UTC). Solo practice still works.";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export type AuthHeaders = Record<string, string>;

export async function api<T>(path: string, init: { method?: string; body?: unknown; auth?: AuthHeaders } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(ORIGIN + path, {
      method: init.method ?? "GET",
      headers: { ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...init.auth },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "offline", navigator.onLine === false ? OFFLINE : BUSY);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok && !data.error && (res.status === 429 || res.status >= 500)) throw new ApiError(res.status, "busy", BUSY);
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? "Something went wrong. Try again.");
  return data as T;
}

export function wsUrl(path: string): string {
  const base = ORIGIN || window.location.origin;
  return base.replace(/^http/, "ws") + path;
}
