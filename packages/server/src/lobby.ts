import { RANKED_DURATION, botLevelFor, isDuration, type DurationSec, type LobbyServerMsg, type QueueKind } from "@qm/shared";
import { verify, type Ticket } from "./auth";
import type { Env } from "./env";
import type { RoomInit } from "./room";

interface Entry {
  key: string;
  name: string;
  kind: "guest" | "user";
  uid?: string;
  rating: number;
  queue: QueueKind;
  duration: DurationSec;
  joinedAt: number;
  /** Recent correct answers per minute reported by the client, for bot difficulty. */
  pace?: number;
}

const RANKED_BASE_WINDOW = 100;
const RANKED_WINDOW_PER_SEC = 25;
const MAX_RANKED_PAIRINGS_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BOT_FILL_MS = { casual: 8_000, ranked: 15_000 } as const;
const MATCH_TICK_MS = 2_000;

/** Single global matchmaker. Sockets hibernate between pairings. */
export class Lobby implements DurableObject {
  private recentPairs = new Map<string, number[]>();

  constructor(private ctx: DurableObjectState, private env: Env) {}

  private entries(): { ws: WebSocket; e: Entry }[] {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ ws, e: ws.deserializeAttachment() as Entry }))
      .filter((x) => x.e && x.e.key)
      .sort((a, b) => a.e.joinedAt - b.e.joinedAt);
  }

  private send(ws: WebSocket, msg: LobbyServerMsg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* closing */
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const ticket = await verify<Ticket>(url.searchParams.get("ticket"), this.env.TOKEN_SECRET);
    if (!ticket || ticket.typ !== "ticket") return new Response("bad ticket", { status: 401 });
    const queue = url.searchParams.get("queue") === "ranked" ? "ranked" : "casual";
    const durationParam = Number(url.searchParams.get("duration"));
    const duration: DurationSec = queue === "ranked" ? RANKED_DURATION : isDuration(durationParam) ? durationParam : 60;
    if (queue === "ranked" && (ticket.kind !== "user" || !ticket.uid)) {
      return new Response("sign in to play ranked", { status: 403 });
    }
    for (const { ws, e } of this.entries()) {
      if (e.key === ticket.key) ws.close(4000, "queued from another tab");
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const pace = Number(url.searchParams.get("pace"));
    const entry: Entry = {
      key: ticket.key, name: ticket.name, kind: ticket.kind, uid: ticket.uid, rating: ticket.rating ?? 1200,
      queue, duration, joinedAt: Date.now(), ...(pace > 0 && pace < 200 ? { pace } : {}),
    };
    server.serializeAttachment(entry);
    await this.tryMatch();
    this.broadcastCounts();
    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcastCounts() {
    const all = this.entries();
    for (const { ws, e } of all) {
      const waiting = all.filter((x) => x.e.queue === e.queue && x.e.duration === e.duration).length;
      const fill = this.botFillMs(e.queue);
      this.send(ws, { t: "queued", queue: e.queue, duration: e.duration, waiting, ...(fill ? { botInMs: Math.max(0, e.joinedAt + fill - Date.now()) } : {}) });
    }
  }

  private botFillMs(queue: QueueKind): number {
    const raw = queue === "ranked" ? this.env.BOT_FILL_RANKED_MS : this.env.BOT_FILL_CASUAL_MS;
    const n = raw === undefined || raw === "" ? DEFAULT_BOT_FILL_MS[queue] : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  private pairAllowed(a: Entry, b: Entry, now: number): boolean {
    if (a.key === b.key) return false;
    if (a.queue !== b.queue || a.duration !== b.duration) return false;
    if (a.queue === "casual") return true;
    if (a.uid === b.uid) return false;
    const waitSec = (now - Math.min(a.joinedAt, b.joinedAt)) / 1000;
    if (Math.abs(a.rating - b.rating) > RANKED_BASE_WINDOW + RANKED_WINDOW_PER_SEC * waitSec) return false;
    const recent = (this.recentPairs.get(pairKey(a, b)) ?? []).filter((t) => now - t < DAY_MS);
    return recent.length < MAX_RANKED_PAIRINGS_PER_DAY;
  }

  private async tryMatch() {
    const now = Date.now();
    const list = this.entries();
    const used = new Set<WebSocket>();
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      if (used.has(a.ws)) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]!;
        if (used.has(b.ws) || !this.pairAllowed(a.e, b.e, now)) continue;
        used.add(a.ws);
        used.add(b.ws);
        await this.createMatch(a, b);
        break;
      }
    }
    // Humans pair first; anyone still alone past the fill wait gets a bot.
    for (const x of list) {
      if (used.has(x.ws)) continue;
      const fill = this.botFillMs(x.e.queue);
      if (fill && now - x.e.joinedAt >= fill) {
        used.add(x.ws);
        await this.createBotMatch(x);
      }
    }
    await this.scheduleAlarm();
  }

  /** Keep re-checking while anyone waits: ranked windows widen and bot fills come due. */
  private async scheduleAlarm() {
    const now = Date.now();
    const left = this.entries();
    if (!left.length) return;
    let next = now + MATCH_TICK_MS;
    for (const { e } of left) {
      const fill = this.botFillMs(e.queue);
      if (fill) next = Math.min(next, Math.max(now + 100, e.joinedAt + fill));
    }
    await this.ctx.storage.setAlarm(next);
  }

  private async createBotMatch(x: { ws: WebSocket; e: Entry }) {
    const roomId = crypto.randomUUID();
    const mode = x.e.queue === "ranked" ? "ranked" : "casual";
    const botLevel = botLevelFor({ pace: x.e.pace, rating: x.e.kind === "user" ? x.e.rating : undefined });
    const init: RoomInit = { roomId, code: null, mode, duration: x.e.duration, hostKey: null, allowed: [x.e.key], botLevel };
    const stub = this.env.ROOM.get(this.env.ROOM.idFromName(roomId));
    const res = await stub.fetch("https://room/init", { method: "POST", body: JSON.stringify(init) });
    if (!res.ok) return;
    logQueueMatch(x.e, "bot", botLevel);
    this.send(x.ws, { t: "matched", roomId, mode, bot: true });
    x.ws.close(1000, "matched");
  }

  private async createMatch(a: { ws: WebSocket; e: Entry }, b: { ws: WebSocket; e: Entry }) {
    const roomId = crypto.randomUUID();
    const mode = a.e.queue === "ranked" ? "ranked" : "casual";
    const init: RoomInit = { roomId, code: null, mode, duration: a.e.duration, hostKey: null, allowed: [a.e.key, b.e.key] };
    const stub = this.env.ROOM.get(this.env.ROOM.idFromName(roomId));
    const res = await stub.fetch("https://room/init", { method: "POST", body: JSON.stringify(init) });
    if (!res.ok) return;
    if (mode === "ranked") {
      const k = pairKey(a.e, b.e);
      this.recentPairs.set(k, [...(this.recentPairs.get(k) ?? []), Date.now()]);
    }
    for (const x of [a, b]) {
      logQueueMatch(x.e, "human");
      this.send(x.ws, { t: "matched", roomId, mode });
      x.ws.close(1000, "matched");
    }
  }

  async alarm() {
    await this.tryMatch();
    this.broadcastCounts();
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string" || raw.length > 128) return;
    try {
      const m = JSON.parse(raw) as { t?: string };
      if (m.t === "leave") ws.close(1000, "left queue");
    } catch {
      /* ignore */
    }
  }

  async webSocketClose() {
    this.broadcastCounts();
  }

  async webSocketError() {
    this.broadcastCounts();
  }
}

/** One structured line per queue match, for Workers Logs: how often players get a real opponent and how long they wait. */
function logQueueMatch(e: Entry, opponent: "human" | "bot", botLevel?: string) {
  console.log(JSON.stringify({
    evt: "queue_match", queue: e.queue, duration: e.duration, kind: e.kind, opponent, botLevel, waitMs: Date.now() - e.joinedAt,
  }));
}

function pairKey(a: Entry, b: Entry) {
  return [a.uid ?? a.key, b.uid ?? b.key].sort().join("|");
}
