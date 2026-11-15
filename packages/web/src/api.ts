const ORIGIN = (import.meta.env.VITE_API_ORIGIN as string | undefined) || "";

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
    throw new ApiError(0, "offline", "Can't reach the game server. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? "Something went wrong. Try again.");
  return data as T;
}

export function wsUrl(path: string): string {
  const base = ORIGIN || window.location.origin;
  return base.replace(/^http/, "ws") + path;
}
