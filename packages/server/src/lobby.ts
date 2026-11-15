import { RANKED_DURATION, isDuration, type DurationSec, type LobbyServerMsg, type QueueKind } from "@qm/shared";
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
}

const RANKED_BASE_WINDOW = 100;
const RANKED_WINDOW_PER_SEC = 25;
const MAX_RANKED_PAIRINGS_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

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
    const entry: Entry = {
      key: ticket.key, name: ticket.name, kind: ticket.kind, uid: ticket.uid, rating: ticket.rating ?? 1200,
      queue, duration, joinedAt: Date.now(),
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
      this.send(ws, { t: "queued", queue: e.queue, duration: e.duration, waiting });
    }
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
    const rankedWaiting = this.entries().filter((x) => x.e.queue === "ranked").length;
    if (rankedWaiting >= 2) await this.ctx.storage.setAlarm(Date.now() + 2000);
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

function pairKey(a: Entry, b: Entry) {
  return [a.uid ?? a.key, b.uid ?? b.key].sort().join("|");
}
