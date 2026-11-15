import type { BotLevel } from "./bot";
import type { Question } from "./questions";
import type { DurationSec, EndReason } from "./rules";

export type Mode = "bot" | "casual" | "ranked" | "private";
export type PlayerKind = "guest" | "user" | "bot";
export type Device = "keyboard" | "touch" | "unknown";

export interface PublicPlayer {
  key: string;
  name: string;
  kind: PlayerKind;
  rating?: number;
  connected: boolean;
}

export interface SelfState {
  index: number;
  correct: number;
  wrong: number;
  hearts: number;
  eliminated: boolean;
}

export interface ProgressState {
  key: string;
  correct: number;
  wrong: number;
  hearts: number;
  eliminated: boolean;
}

export interface ResultRow {
  key: string;
  name: string;
  kind: PlayerKind;
  placement: number;
  outcome: "win" | "loss" | "draw";
  correct: number;
  wrong: number;
  hearts: number;
  eliminated: boolean;
  eliminatedAtMs: number | null;
  ratingBefore?: number;
  ratingAfter?: number;
}

export interface MatchResults {
  matchId: string;
  mode: Mode;
  duration: DurationSec;
  endReason: EndReason;
  rows: ResultRow[];
  rated: boolean;
}

export type RoomPhase = "lobby" | "countdown" | "playing" | "results";

export interface RoomSnapshot {
  roomId: string;
  code: string | null;
  mode: Mode;
  phase: RoomPhase;
  hostKey: string | null;
  duration: DurationSec;
  botLevel?: BotLevel;
  players: PublicPlayer[];
  you: string;
}

export type ClientMsg =
  | { t: "hello"; device: Device }
  | { t: "ping"; c: number }
  | { t: "ans"; i: number; v: number }
  | { t: "resign" }
  | { t: "setDuration"; duration: DurationSec }
  | { t: "start" }
  | { t: "leave" };

export type ServerMsg =
  | { t: "pong"; c: number; s: number }
  | { t: "room"; room: RoomSnapshot }
  | {
      t: "match";
      matchId: string;
      startAt: number;
      endAt: number;
      duration: DurationSec;
      serverNow: number;
      self: SelfState | null;
      questions: Question[];
      progress: ProgressState[];
    }
  | { t: "q"; questions: Question[] }
  | { t: "ack"; i: number; ok: boolean; self: SelfState }
  | { t: "progress"; p: ProgressState }
  | { t: "results"; results: MatchResults }
  | { t: "error"; code: string; message: string };

export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case "hello":
      return { t: "hello", device: o.device === "keyboard" || o.device === "touch" ? o.device : "unknown" };
    case "ping":
      return typeof o.c === "number" ? { t: "ping", c: o.c } : null;
    case "ans":
      return Number.isInteger(o.i) && typeof o.v === "number" && Number.isFinite(o.v)
        ? { t: "ans", i: o.i as number, v: o.v }
        : null;
    case "resign":
    case "start":
    case "leave":
      return { t: o.t };
    case "setDuration":
      return typeof o.duration === "number" ? { t: "setDuration", duration: o.duration as DurationSec } : null;
    default:
      return null;
  }
}

export type QueueKind = "casual" | "ranked";

export type LobbyServerMsg =
  | { t: "queued"; queue: QueueKind; duration: DurationSec; waiting: number }
  | { t: "matched"; roomId: string; mode: Mode }
  | { t: "error"; code: string; message: string };

export type LobbyClientMsg = { t: "ping"; c: number } | { t: "leave" };
