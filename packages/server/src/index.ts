import { BOT_LEVELS, cleanSource, isBotLevel, isEventName, isDuration, suggestUsername, validateUsername, levelFor, type DurationSec } from "@qm/shared";
import { randomId, sign, verify, verifyFirebaseToken, type FirebaseIdentity, type GuestToken, type Ticket } from "./auth";
import { deleteAccount, getProfile, upsertProfile } from "./db";
import type { Env } from "./env";
import type { RoomInit } from "./room";

export { Room } from "./room";
export { Lobby } from "./lobby";

const GUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TICKET_TTL_MS = 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

// Best-effort per-isolate limiter. Real protection comes from short tickets,
// unguessable room codes and Cloudflare's free-plan hard request cap.
const buckets = new Map<string, { n: number; reset: number }>();
let rateLimitsOff = false;

function limited(key: string, max: number, windowMs: number): boolean {
  if (rateLimitsOff) return false;
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    if (buckets.size > 5000) buckets.clear();
    buckets.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  b.n++;
  return b.n > max;
}

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Guest-Token",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
function err(status: number, code: string, message: string) {
  return json({ error: code, message }, status);
}

type Principal =
  | { kind: "guest"; key: string; name: string }
  | { kind: "user"; key: string; name: string; uid: string; rating: number; identity: FirebaseIdentity };

async function firebaseFrom(req: Request, env: Env): Promise<FirebaseIdentity | null> {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return verifyFirebaseToken(auth.slice(7), env);
}

async function principalFrom(req: Request, env: Env): Promise<Principal | Response> {
  const identity = await firebaseFrom(req, env);
  if (identity) {
    const profile = await getProfile(env, identity.uid);
    if (!profile) return err(409, "profile_required", "Choose a username to finish setting up your account.");
    return { kind: "user", key: `u:${identity.uid}`, name: profile.username, uid: identity.uid, rating: profile.rating, identity };
  }
  const guest = await verify<GuestToken>(req.headers.get("X-Guest-Token"), env.TOKEN_SECRET);
  if (guest?.typ === "guest") return { kind: "guest", key: `g:${guest.gid}`, name: guest.name };
  return err(401, "unauthenticated", "Play as a guest or sign in first.");
}

async function readJson<T>(req: Request): Promise<Partial<T>> {
  try {
    const text = await req.text();
    if (text.length > 4096) return {};
    return text ? (JSON.parse(text) as Partial<T>) : {};
  } catch {
    return {};
  }
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const ip = req.headers.get("CF-Connecting-IP") ?? "local";

  if (path === "/api/health") return json({ ok: true, now: Date.now() });

  if (path === "/api/names/suggest" && req.method === "GET") {
    return json({ username: suggestUsername() });
  }

  if (path === "/api/guest" && req.method === "POST") {
    if (limited(`guest:${ip}`, 20, 60 * 60 * 1000)) return err(429, "rate_limited", "Too many guest sessions. Try again later.");
    const body = await readJson<{ username: string; gid: string }>(req);
    const v = validateUsername(body.username);
    if (!v.ok) return err(400, "bad_username", v.reason);
    // Renaming keeps the same guest id when the old token is presented.
    const prev = await verify<GuestToken>(req.headers.get("X-Guest-Token"), env.TOKEN_SECRET);
    const gid = prev?.typ === "guest" ? prev.gid : randomId();
    const token = await sign({ typ: "guest", gid, name: v.name, exp: Date.now() + GUEST_TTL_MS } satisfies GuestToken, env.TOKEN_SECRET);
    return json({ token, key: `g:${gid}`, username: v.name });
  }

  if (path === "/api/me") {
    const identity = await firebaseFrom(req, env);
    if (!identity) return err(401, "unauthenticated", "Sign in first.");
    if (req.method === "GET") {
      const profile = await getProfile(env, identity.uid);
      return json({ profile: profile && { ...profile, level: levelFor(profile.total_correct) }, emailVerified: identity.emailVerified });
    }
    if (req.method === "PUT") {
      if (limited(`me:${identity.uid}`, 10, 60 * 60 * 1000)) return err(429, "rate_limited", "Too many changes. Try again later.");
      const body = await readJson<{ username: string }>(req);
      const v = validateUsername(body.username);
      if (!v.ok) return err(400, "bad_username", v.reason);
      const res = await upsertProfile(env, identity.uid, v.name, identity.provider);
      if (res === "taken") return err(409, "username_taken", "That username is taken.");
      const profile = await getProfile(env, identity.uid);
      return json({ profile: profile && { ...profile, level: levelFor(profile.total_correct) } });
    }
    if (req.method === "DELETE") {
      await deleteAccount(env, identity.uid);
      return json({ ok: true });
    }
  }

  if (path === "/api/ticket" && req.method === "POST") {
    const p = await principalFrom(req, env);
    if (p instanceof Response) return p;
    const ticket: Ticket = {
      typ: "ticket", key: p.key, kind: p.kind, name: p.name, exp: Date.now() + TICKET_TTL_MS,
      ...(p.kind === "user" ? { uid: p.uid, rating: p.rating } : {}),
    };
    return json({ ticket: await sign(ticket, env.TOKEN_SECRET), key: p.key, name: p.name, kind: p.kind });
  }

  if (path === "/api/rooms" && req.method === "POST") {
    const p = await principalFrom(req, env);
    if (p instanceof Response) return p;
    if (limited(`rooms:${p.key}`, 20, 60 * 60 * 1000)) return err(429, "rate_limited", "Too many rooms. Try again later.");
    const body = await readJson<{ duration: number }>(req);
    const duration: DurationSec = isDuration(body.duration) ? body.duration : 60;
    for (let attempt = 0; attempt < 5; attempt++) {
      const bytes = crypto.getRandomValues(new Uint8Array(6));
      const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
      const roomId = `code-${code}`;
      const init: RoomInit = { roomId, code, mode: "private", duration, hostKey: p.key };
      const res = await env.ROOM.get(env.ROOM.idFromName(roomId)).fetch("https://room/init", { method: "POST", body: JSON.stringify(init) });
      if (res.ok) return json({ roomId, code });
    }
    return err(503, "no_code", "Couldn't create a room. Try again.");
  }

  if (path === "/api/bot" && req.method === "POST") {
    const p = await principalFrom(req, env);
    if (p instanceof Response) return p;
    if (limited(`bot:${p.key}`, 60, 60 * 60 * 1000)) return err(429, "rate_limited", "Too many bot matches. Take a breather.");
    const body = await readJson<{ duration: number; level: string }>(req);
    const duration: DurationSec = isDuration(body.duration) ? body.duration : 60;
    const level = isBotLevel(body.level) ? body.level : "medium";
    const roomId = `bot-${crypto.randomUUID()}`;
    const init: RoomInit = { roomId, code: null, mode: "bot", duration, hostKey: p.key, botLevel: level };
    await env.ROOM.get(env.ROOM.idFromName(roomId)).fetch("https://room/init", { method: "POST", body: JSON.stringify(init) });
    return json({ roomId, level: BOT_LEVELS[level].label });
  }

  const wsRoom = path.match(/^\/ws\/room\/([A-Za-z0-9-]{6,64})$/);
  if (wsRoom) {
    let roomId = wsRoom[1]!;
    if (roomId.startsWith("code-")) {
      const code = roomId.slice(5).toUpperCase();
      if (!CODE_RE.test(code)) return err(404, "room_not_found", "That room code doesn't exist.");
      if (limited(`join:${ip}`, 60, 10 * 60 * 1000)) return err(429, "rate_limited", "Too many join attempts. Wait a few minutes.");
      roomId = `code-${code}`;
    }
    const u = new URL(req.url);
    u.pathname = "/ws";
    return env.ROOM.get(env.ROOM.idFromName(roomId)).fetch(new Request(u, req));
  }

  if (path === "/ws/lobby") {
    return env.LOBBY.get(env.LOBBY.idFromName("global")).fetch(req);
  }

  if (path === "/api/event" && req.method === "POST") {
    if (limited(`event:${ip}`, 30, 60 * 60 * 1000)) return new Response(null, { status: 204 });
    const body = await readJson<{ name: string; src: string }>(req);
    if (!isEventName(body.name)) return err(400, "bad_event", "Unknown event.");
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      `INSERT INTO daily_events (day, name, src, n) VALUES (?, ?, ?, 1)
       ON CONFLICT (day, name, src) DO UPDATE SET n = n + 1`,
    )
      .bind(day, body.name, cleanSource(body.src))
      .run();
    return new Response(null, { status: 204 });
  }

  if (path === "/api/leaderboard" && req.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT username, rating, rated_games, wins, losses, draws, total_correct, best_60
       FROM players WHERE rated_games > 0 ORDER BY rating DESC LIMIT 100`,
    ).all();
    const res = json({ players: rows.results.map((r) => ({ ...r, level: levelFor(Number(r.total_correct)) })) });
    res.headers.set("Cache-Control", "public, max-age=60");
    return res;
  }

  const player = path.match(/^\/api\/players\/([A-Za-z0-9_-]{3,20})$/);
  if (player && req.method === "GET") {
    const profile = await env.DB.prepare(
      `SELECT uid, username, rating, rated_games, wins, losses, draws, total_correct, best_60, created_at
       FROM players WHERE username = ?`,
    )
      .bind(player[1])
      .first<{ uid: string; total_correct: number }>();
    if (!profile) return err(404, "not_found", "No player with that username.");
    const history = await env.DB.prepare(
      `SELECT m.id, m.mode, m.duration_s, m.ended_at, m.end_reason, m.rated, mp.placement, mp.outcome, mp.correct,
              mp.wrong, mp.rating_before, mp.rating_after
       FROM match_players mp JOIN matches m ON m.id = mp.match_id
       WHERE mp.uid = ? ORDER BY m.ended_at DESC LIMIT 20`,
    )
      .bind(profile.uid)
      .all();
    const { uid: _uid, ...pub } = profile;
    return json({ profile: { ...pub, level: levelFor(profile.total_correct) }, history: history.results });
  }

  if (path === "/api/stats/hearts" && req.method === "GET") {
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 30));
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = await env.DB.prepare(
      `SELECT m.duration_s AS duration, m.mode AS mode, mp.wrong AS wrong, COUNT(*) AS players,
              SUM(CASE WHEN mp.eliminated = 1 AND m.end_reason = 'hearts' THEN 1 ELSE 0 END) AS eliminated,
              AVG(mp.correct) AS avg_correct
       FROM match_players mp JOIN matches m ON m.id = mp.match_id
       WHERE mp.kind != 'bot' AND m.ended_at >= ?
       GROUP BY m.duration_s, m.mode, mp.wrong ORDER BY m.duration_s, m.mode, mp.wrong`,
    )
      .bind(since)
      .all();
    const matches = await env.DB.prepare(
      `SELECT end_reason, COUNT(*) AS n FROM matches WHERE ended_at >= ? GROUP BY end_reason`,
    )
      .bind(since)
      .all();
    return json({ days, distribution: rows.results, endReasons: matches.results });
  }

  return err(404, "not_found", "Not found.");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    rateLimitsOff = env.DISABLE_RATE_LIMITS === "true";
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    let res: Response;
    try {
      res = await route(req, env);
    } catch (e) {
      console.error(e);
      res = err(500, "server_error", "Something went wrong on our side.");
    }
    if (res.status === 101) return res;
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
} satisfies ExportedHandler<Env>;
