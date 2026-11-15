import {
  answerOf, botSchedule, botStateAt, BOT_LEVELS, COUNTDOWN_MS, END_GRACE_MS, eloUpdate, isDuration,
  LOOKAHEAD, MAX_ROOM_PLAYERS, MIN_SUBMIT_GAP_MS, parseClientMsg, placements, questionAt,
  STARTING_HEARTS, WRONG_COOLDOWN_MS,
  type BotEvent, type BotLevel, type Device, type DurationSec, type EndReason, type MatchResults,
  type Mode, type ProgressState, type PublicPlayer, type ResultRow, type RoomPhase, type RoomSnapshot,
  type SelfState, type ServerMsg, type Standing,
} from "@qm/shared";
import { randomId, verify, type Ticket } from "./auth";
import { recordMatch, type RecordedPlayer } from "./db";
import type { Env } from "./env";

export interface RoomInit {
  roomId: string;
  code: string | null;
  mode: Mode;
  duration: DurationSec;
  hostKey: string | null;
  botLevel?: BotLevel;
  /** Queue matches: only these keys may connect, and the match starts when all have. */
  allowed?: string[];
}

interface RoomConfig extends RoomInit {
  createdAt: number;
}

interface Member {
  key: string;
  name: string;
  kind: "guest" | "user";
  uid?: string;
  rating?: number;
  device: Device;
}

interface PlayerRun {
  key: string;
  name: string;
  kind: "guest" | "user" | "bot";
  uid?: string;
  rating?: number;
  device: Device;
  index: number;
  correct: number;
  wrong: number;
  lastSubmitAt: number;
  lastWrongAt: number;
  lastCorrectAtMs: number | null;
  eliminatedAtMs: number | null;
  resigned: boolean;
  mistakes: number[];
}

interface MatchState {
  matchId: string;
  seed: string;
  mode: Mode;
  duration: DurationSec;
  startAt: number;
  endAt: number;
  runs: Record<string, PlayerRun>;
  bot?: { key: string; level: BotLevel };
  ended: boolean;
}

const QUEUE_NO_SHOW_MS = 20_000;
const SNAPSHOT_EVERY_MS = 5_000;
const BOT_KEY = "bot";

export class Room implements DurableObject {
  private loaded = false;
  private config: RoomConfig | null = null;
  private members = new Map<string, Member>();
  private match: MatchState | null = null;
  private results: MatchResults | null = null;
  private botEvents: BotEvent[] | null = null;
  private lastSnapshotAt = 0;
  private lastBotBroadcast = -1;

  constructor(private ctx: DurableObjectState, private env: Env) {}

  private async load() {
    if (this.loaded) return;
    const [config, members, match, results] = await Promise.all([
      this.ctx.storage.get<RoomConfig>("config"),
      this.ctx.storage.get<Member[]>("members"),
      this.ctx.storage.get<MatchState>("match"),
      this.ctx.storage.get<MatchResults>("results"),
    ]);
    this.config = config ?? null;
    this.members = new Map((members ?? []).map((m) => [m.key, m]));
    this.match = match ?? null;
    this.results = results ?? null;
    this.loaded = true;
  }

  private async saveMembers() {
    await this.ctx.storage.put("members", [...this.members.values()]);
  }

  private async saveMatch() {
    this.lastSnapshotAt = Date.now();
    await this.ctx.storage.put("match", this.match);
  }

  async fetch(req: Request): Promise<Response> {
    await this.load();
    const url = new URL(req.url);
    if (url.pathname === "/init" && req.method === "POST") {
      if (this.config) return new Response("exists", { status: 409 });
      const init = (await req.json()) as RoomInit;
      this.config = { ...init, createdAt: Date.now() };
      await this.ctx.storage.put("config", this.config);
      if (init.mode === "casual" || init.mode === "ranked") {
        await this.ctx.storage.setAlarm(Date.now() + QUEUE_NO_SHOW_MS);
      } else {
        // Idle rooms clean themselves up.
        await this.ctx.storage.setAlarm(Date.now() + 6 * 60 * 60 * 1000);
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      if (!this.config) return new Response("room not found", { status: 404 });
      const ticket = await verify<Ticket>(url.searchParams.get("ticket"), this.env.TOKEN_SECRET);
      if (!ticket || ticket.typ !== "ticket") return new Response("bad ticket", { status: 401 });
      const cfg = this.config;
      if (cfg.allowed && !cfg.allowed.includes(ticket.key)) return new Response("not in this match", { status: 403 });
      const isPlayer = this.match?.runs[ticket.key];
      if (cfg.mode === "private" && !this.members.has(ticket.key) && !isPlayer && this.members.size >= MAX_ROOM_PLAYERS) {
        return new Response("room full", { status: 409 });
      }
      if (cfg.mode === "bot" && cfg.hostKey !== ticket.key) return new Response("not your match", { status: 403 });

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      for (const old of this.ctx.getWebSockets(ticket.key)) {
        try {
          old.close(4000, "replaced by a newer connection");
        } catch {
          /* already closed */
        }
      }
      this.ctx.acceptWebSocket(server, [ticket.key]);
      server.serializeAttachment({ key: ticket.key });
      const existing = this.members.get(ticket.key);
      this.members.set(ticket.key, {
        key: ticket.key, name: ticket.name, kind: ticket.kind, uid: ticket.uid, rating: ticket.rating,
        device: existing?.device ?? "unknown",
      });
      if (cfg.mode === "private" && (!cfg.hostKey || !this.members.has(cfg.hostKey))) {
        cfg.hostKey = ticket.key;
        await this.ctx.storage.put("config", cfg);
      }
      await this.saveMembers();
      this.sendSnapshotTo(server, ticket.key);
      this.broadcastRoom();
      await this.maybeAutoStart();
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("not found", { status: 404 });
  }

  // ---------- snapshots ----------

  private connectedKeys(): Set<string> {
    const keys = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as { key?: string } | null;
      if (a?.key) keys.add(a.key);
    }
    return keys;
  }

  private phase(): RoomPhase {
    const m = this.match;
    if (m && !m.ended) return Date.now() < m.startAt ? "countdown" : "playing";
    if (this.results) return "results";
    return "lobby";
  }

  private roomSnapshot(you: string): RoomSnapshot {
    const cfg = this.config!;
    const connected = this.connectedKeys();
    const players: PublicPlayer[] = [];
    const seen = new Set<string>();
    const inMatch = this.match && !this.match.ended ? Object.values(this.match.runs) : [];
    for (const r of inMatch) {
      seen.add(r.key);
      players.push({ key: r.key, name: r.name, kind: r.kind, rating: r.rating, connected: r.kind === "bot" || connected.has(r.key) });
    }
    for (const m of this.members.values()) {
      if (seen.has(m.key)) continue;
      if (!connected.has(m.key) && cfg.mode === "private") continue;
      players.push({ key: m.key, name: m.name, kind: m.kind, rating: m.rating, connected: connected.has(m.key) });
    }
    return {
      roomId: cfg.roomId, code: cfg.code, mode: cfg.mode, phase: this.phase(), hostKey: cfg.hostKey,
      duration: cfg.duration, botLevel: cfg.botLevel, players, you,
    };
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket closing */
    }
  }

  private sendTo(key: string, msg: ServerMsg) {
    for (const ws of this.ctx.getWebSockets(key)) this.send(ws, msg);
  }

  private broadcast(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }

  private broadcastRoom() {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as { key: string };
      this.send(ws, { t: "room", room: this.roomSnapshot(a.key) });
    }
  }

  private selfState(run: PlayerRun): SelfState {
    return {
      index: run.index, correct: run.correct, wrong: run.wrong,
      hearts: Math.max(0, STARTING_HEARTS - run.wrong), eliminated: run.eliminatedAtMs !== null,
    };
  }

  private progressOf(run: PlayerRun): ProgressState {
    return {
      key: run.key, correct: run.correct, wrong: run.wrong,
      hearts: Math.max(0, STARTING_HEARTS - run.wrong), eliminated: run.eliminatedAtMs !== null,
    };
  }

  private questionsFrom(index: number, count: number) {
    const m = this.match!;
    return Array.from({ length: count }, (_, k) => questionAt(m.seed, index + k));
  }

  private matchMsgFor(key: string): ServerMsg {
    const m = this.match!;
    this.syncBot();
    const run = m.runs[key];
    const self = run && run.kind !== "bot" ? this.selfState(run) : null;
    return {
      t: "match", matchId: m.matchId, startAt: m.startAt, endAt: m.endAt, duration: m.duration,
      serverNow: Date.now(), self,
      questions: self && !self.eliminated ? this.questionsFrom(self.index, LOOKAHEAD + 1) : [],
      progress: Object.values(m.runs).map((r) => this.progressOf(r)),
    };
  }

  private sendSnapshotTo(ws: WebSocket, key: string) {
    this.send(ws, { t: "room", room: this.roomSnapshot(key) });
    if (this.match && !this.match.ended) this.send(ws, this.matchMsgFor(key));
    else if (this.results) this.send(ws, { t: "results", results: this.results });
  }

  // ---------- lifecycle ----------

  private async maybeAutoStart() {
    const cfg = this.config!;
    if (this.match && !this.match.ended) return;
    if (this.results && cfg.mode !== "private") return;
    if (cfg.mode === "bot") {
      const host = cfg.hostKey && this.members.get(cfg.hostKey);
      if (host) await this.startMatch([host]);
      return;
    }
    if (cfg.allowed) {
      const connected = this.connectedKeys();
      if (cfg.allowed.every((k) => connected.has(k))) {
        await this.startMatch(cfg.allowed.map((k) => this.members.get(k)!).filter(Boolean));
      }
    }
  }

  private async startMatch(players: Member[]) {
    const cfg = this.config!;
    const now = Date.now();
    const runs: Record<string, PlayerRun> = {};
    const newRun = (p: Omit<PlayerRun, "index" | "correct" | "wrong" | "lastSubmitAt" | "lastWrongAt" | "lastCorrectAtMs" | "eliminatedAtMs" | "resigned" | "mistakes">): PlayerRun => ({
      ...p, index: 0, correct: 0, wrong: 0, lastSubmitAt: 0, lastWrongAt: 0, lastCorrectAtMs: null,
      eliminatedAtMs: null, resigned: false, mistakes: [],
    });
    for (const p of players) {
      runs[p.key] = newRun({ key: p.key, name: p.name, kind: p.kind, uid: p.uid, rating: p.rating, device: p.device });
    }
    let bot: MatchState["bot"];
    if (cfg.mode === "bot") {
      const level = cfg.botLevel ?? "medium";
      bot = { key: BOT_KEY, level };
      runs[BOT_KEY] = newRun({ key: BOT_KEY, name: `${BOT_LEVELS[level].label} Bot`, kind: "bot", device: "unknown" });
    }
    const startAt = now + COUNTDOWN_MS;
    this.match = {
      matchId: crypto.randomUUID(), seed: randomId(16), mode: cfg.mode, duration: cfg.duration,
      startAt, endAt: startAt + cfg.duration * 1000, runs, bot, ended: false,
    };
    this.botEvents = null;
    this.lastBotBroadcast = -1;
    this.results = null;
    await this.ctx.storage.delete("results");
    await this.saveMatch();
    await this.ctx.storage.setAlarm(startAt);
    this.broadcastRoom();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as { key: string };
      this.send(ws, this.matchMsgFor(a.key));
    }
  }

  private botEventsFor(m: MatchState): BotEvent[] {
    if (!this.botEvents) this.botEvents = botSchedule(m.seed, m.bot!.level, m.duration * 1000);
    return this.botEvents;
  }

  /** Bring the bot's run up to date with the clock and broadcast if it moved. */
  private syncBot(at = Date.now()) {
    const m = this.match;
    if (!m?.bot || m.ended) return;
    const run = m.runs[m.bot.key]!;
    const elapsed = Math.min(at, m.endAt) - m.startAt;
    if (elapsed < 0) return;
    const s = botStateAt(this.botEventsFor(m), elapsed);
    if (s.correct === run.correct && s.wrong === run.wrong) return;
    run.correct = s.correct;
    run.index = s.correct;
    run.wrong = s.wrong;
    run.lastCorrectAtMs = s.lastCorrectAtMs;
    this.broadcast({ t: "progress", p: this.progressOf(run) });
  }

  async alarm() {
    await this.load();
    const cfg = this.config;
    if (!cfg) return;
    const now = Date.now();
    const m = this.match;
    if (m && !m.ended) {
      if (now >= m.endAt + END_GRACE_MS) {
        await this.finish("time");
        return;
      }
      if (now >= m.startAt && this.lastBotBroadcast < 0) this.broadcastRoom();
      this.lastBotBroadcast = now;
      this.syncBot(now);
      if (now - this.lastSnapshotAt > SNAPSHOT_EVERY_MS) await this.saveMatch();
      // Ticking keeps the object warm during a match and drives bot progress.
      const tick = m.bot ? 500 : 2000;
      await this.ctx.storage.setAlarm(Math.min(m.endAt + END_GRACE_MS, Math.max(now, m.startAt) + tick));
      return;
    }
    if ((cfg.mode === "casual" || cfg.mode === "ranked") && !m && !this.results) {
      this.broadcast({ t: "error", code: "no_show", message: "Your opponent didn't connect. Nothing was recorded." });
      for (const ws of this.ctx.getWebSockets()) ws.close(4001, "no show");
      await this.ctx.storage.deleteAll();
      return;
    }
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.loaded = false;
      return;
    }
    await this.ctx.storage.setAlarm(now + 60 * 60 * 1000);
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    await this.load();
    const { key } = ws.deserializeAttachment() as { key: string };
    const msg = parseClientMsg(typeof raw === "string" ? raw : null);
    if (!msg) return;
    const cfg = this.config!;
    switch (msg.t) {
      case "ping":
        this.send(ws, { t: "pong", c: msg.c, s: Date.now() });
        return;
      case "hello": {
        const mem = this.members.get(key);
        if (mem) mem.device = msg.device;
        const run = this.match?.runs[key];
        if (run) run.device = msg.device;
        return;
      }
      case "ans":
        await this.onAnswer(ws, key, msg.i, msg.v);
        return;
      case "resign": {
        const m = this.match;
        const run = m?.runs[key];
        if (!m || m.ended || !run || run.eliminatedAtMs !== null) return;
        run.resigned = true;
        run.eliminatedAtMs = Math.max(0, Date.now() - m.startAt);
        this.broadcast({ t: "progress", p: this.progressOf(run) });
        await this.checkEarlyEnd("resign");
        return;
      }
      case "setDuration":
        if (cfg.mode !== "private" || cfg.hostKey !== key || !isDuration(msg.duration)) return;
        if (this.match && !this.match.ended) return;
        cfg.duration = msg.duration;
        await this.ctx.storage.put("config", cfg);
        this.broadcastRoom();
        return;
      case "start": {
        if (cfg.mode !== "private" || cfg.hostKey !== key) return;
        if (this.match && !this.match.ended) return;
        const connected = this.connectedKeys();
        const players = [...this.members.values()].filter((m) => connected.has(m.key)).slice(0, MAX_ROOM_PLAYERS);
        if (players.length < 2) {
          this.send(ws, { t: "error", code: "need_players", message: "You need at least two players to start." });
          return;
        }
        await this.startMatch(players);
        return;
      }
      case "leave":
        ws.close(1000, "left");
        await this.onLeave(key);
        return;
    }
  }

  private async onAnswer(ws: WebSocket, key: string, i: number, v: number) {
    const m = this.match;
    if (!m || m.ended) return;
    const run = m.runs[key];
    if (!run || run.kind === "bot" || run.eliminatedAtMs !== null) return;
    const now = Date.now();
    if (now < m.startAt || now > m.endAt + END_GRACE_MS) return;
    // Stale or duplicate submissions for an earlier question never cost a heart.
    if (i !== run.index) {
      this.send(ws, { t: "ack", i, ok: false, self: this.selfState(run) });
      return;
    }
    const tooFast = now - run.lastSubmitAt < MIN_SUBMIT_GAP_MS;
    run.lastSubmitAt = now;
    const elapsed = now - m.startAt;
    if (v === answerOf(questionAt(m.seed, i))) {
      run.correct++;
      run.index++;
      run.lastCorrectAtMs = elapsed;
      this.send(ws, { t: "ack", i, ok: true, self: this.selfState(run) });
      this.send(ws, { t: "q", questions: [questionAt(m.seed, run.index + LOOKAHEAD)] });
      this.broadcast({ t: "progress", p: this.progressOf(run) });
      return;
    }
    // Correct answers are never throttled; wrong ones inside the cooldown are free.
    if (tooFast || now - run.lastWrongAt < WRONG_COOLDOWN_MS) {
      this.send(ws, { t: "ack", i, ok: false, self: this.selfState(run) });
      return;
    }
    run.wrong++;
    run.lastWrongAt = now;
    run.mistakes.push(elapsed);
    if (run.wrong >= STARTING_HEARTS) run.eliminatedAtMs = elapsed;
    this.send(ws, { t: "ack", i, ok: false, self: this.selfState(run) });
    this.broadcast({ t: "progress", p: this.progressOf(run) });
    if (run.eliminatedAtMs !== null) await this.checkEarlyEnd("hearts");
    else await this.saveMatch();
  }

  private async checkEarlyEnd(reason: EndReason) {
    const m = this.match!;
    this.syncBot();
    const runs = Object.values(m.runs);
    const alive = runs.filter((r) => r.eliminatedAtMs === null);
    if (alive.length <= 1 && runs.length >= 2) await this.finish(reason);
    else await this.saveMatch();
  }

  private async onLeave(key: string) {
    const cfg = this.config!;
    if (cfg.mode === "private" && !(this.match && !this.match.ended)) {
      this.members.delete(key);
      if (cfg.hostKey === key) {
        const connected = this.connectedKeys();
        cfg.hostKey = [...this.members.keys()].find((k) => connected.has(k)) ?? null;
        await this.ctx.storage.put("config", cfg);
      }
      await this.saveMembers();
    }
    this.broadcastRoom();
  }

  async webSocketClose(ws: WebSocket) {
    await this.load();
    const a = ws.deserializeAttachment() as { key: string } | null;
    if (!a) return;
    if (this.ctx.getWebSockets(a.key).some((s) => s !== ws)) return;
    await this.onLeave(a.key);
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  private async finish(reason: EndReason) {
    const m = this.match;
    if (!m || m.ended) return;
    const endedAt = Math.min(Date.now(), m.endAt);
    this.syncBot(endedAt);
    m.ended = true;
    await this.saveMatch();

    const runs = Object.values(m.runs);
    const standings: Standing[] = runs.map((r) => ({
      key: r.key, correct: r.correct, wrong: r.wrong, eliminated: r.eliminatedAtMs !== null,
      eliminatedAtMs: r.eliminatedAtMs, lastCorrectAtMs: r.lastCorrectAtMs,
    }));
    const place = placements(standings);
    const winners = runs.filter((r) => place.get(r.key) === 1).length;
    const outcomeOf = (r: PlayerRun): ResultRow["outcome"] =>
      place.get(r.key) === 1 ? (winners === 1 ? "win" : "draw") : "loss";

    const humans = runs.filter((r) => r.kind === "user");
    const rated = m.mode === "ranked" && runs.length === 2 && humans.length === 2;
    const rows: ResultRow[] = runs
      .map((r) => ({
        key: r.key, name: r.name, kind: r.kind, placement: place.get(r.key)!, outcome: outcomeOf(r),
        correct: r.correct, wrong: r.wrong, hearts: Math.max(0, STARTING_HEARTS - r.wrong),
        eliminated: r.eliminatedAtMs !== null, eliminatedAtMs: r.eliminatedAtMs,
      }))
      .sort((a, b) => a.placement - b.placement);

    const recorded: RecordedPlayer[] = runs.map((r) => ({
      key: r.key, uid: r.uid, kind: r.kind, name: r.name, placement: place.get(r.key)!, outcome: outcomeOf(r),
      correct: r.correct, wrong: r.wrong, questionsReached: r.kind === "bot" ? r.index : r.index + 1,
      heartsLeft: Math.max(0, STARTING_HEARTS - r.wrong), eliminatedAtMs: r.eliminatedAtMs,
      mistakes: r.mistakes, device: r.device,
    }));

    let ratings: Map<string, { before: number; after: number }> | undefined;
    try {
      ratings = await recordMatch(this.env, {
        id: m.matchId, mode: m.mode, duration: m.duration, seed: m.seed, startedAt: m.startAt, endedAt,
        endReason: reason, rated, players: recorded,
        rate: rated
          ? (cur) => {
              const [a, b] = humans as [PlayerRun, PlayerRun];
              const ca = cur.get(a.uid!)!;
              const cb = cur.get(b.uid!)!;
              const score = (r: PlayerRun) => (outcomeOf(r) === "win" ? 1 : outcomeOf(r) === "draw" ? 0.5 : 0);
              return new Map([
                [a.uid!, eloUpdate(ca.rating, cb.rating, score(a), ca.ratedGames)],
                [b.uid!, eloUpdate(cb.rating, ca.rating, score(b), cb.ratedGames)],
              ]);
            }
          : undefined,
      });
    } catch (err) {
      console.error("recordMatch failed", err);
    }
    if (ratings) {
      for (const row of rows) {
        const uid = m.runs[row.key]?.uid;
        const rt = uid ? ratings.get(uid) : undefined;
        if (rt) {
          row.ratingBefore = rt.before;
          row.ratingAfter = rt.after;
        }
      }
    }

    this.results = { matchId: m.matchId, mode: m.mode, duration: m.duration, endReason: reason, rows, rated: rated && !!ratings, seed: m.seed };
    this.match = null;
    await this.ctx.storage.delete("match");
    await this.ctx.storage.put("results", this.results);
    this.broadcast({ t: "results", results: this.results });
    this.broadcastRoom();
    await this.ctx.storage.setAlarm(Date.now() + (this.config!.mode === "private" ? 60 * 60 * 1000 : 10 * 60 * 1000));
  }
}
