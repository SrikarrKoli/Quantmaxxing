import { DEFAULT_RATING, type Device, type EndReason, type Mode, type PlayerKind, type ResultRow } from "@qm/shared";
import type { Env } from "./env";

export interface RecordedPlayer {
  key: string;
  uid?: string;
  kind: PlayerKind;
  name: string;
  placement: number;
  outcome: ResultRow["outcome"];
  correct: number;
  wrong: number;
  questionsReached: number;
  heartsLeft: number;
  eliminatedAtMs: number | null;
  mistakes: number[];
  device: Device;
}

export interface RecordInput {
  id: string;
  mode: Mode;
  duration: number;
  seed: string;
  startedAt: number;
  endedAt: number;
  endReason: EndReason;
  rated: boolean;
  players: RecordedPlayer[];
  rate?: (current: Map<string, { rating: number; ratedGames: number }>) => Map<string, number>;
}

/**
 * Writes the match, every participant row and account stat changes in one D1
 * batch (a single transaction). The match id is the primary key, so a retried
 * write fails as a whole and ratings can never be applied twice.
 */
export async function recordMatch(env: Env, input: RecordInput) {
  const uids = input.players.map((p) => p.uid).filter((u): u is string => !!u);
  const current = new Map<string, { rating: number; ratedGames: number }>();
  if (uids.length) {
    const rows = await env.DB.prepare(
      `SELECT uid, rating, rated_games FROM players WHERE uid IN (${uids.map(() => "?").join(",")})`,
    )
      .bind(...uids)
      .all<{ uid: string; rating: number; rated_games: number }>();
    for (const r of rows.results) current.set(r.uid, { rating: r.rating, ratedGames: r.rated_games });
  }
  const rated = input.rated && uids.length === 2 && uids.every((u) => current.has(u));
  const next = rated && input.rate ? input.rate(current) : undefined;

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO matches (id, mode, duration_s, seed, started_at, ended_at, end_reason, rated, player_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(input.id, input.mode, input.duration, input.seed, input.startedAt, input.endedAt, input.endReason, next ? 1 : 0, input.players.length),
  ];
  for (const p of input.players) {
    const cur = p.uid ? current.get(p.uid) : undefined;
    const after = p.uid ? next?.get(p.uid) : undefined;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO match_players (match_id, player_key, uid, kind, username, placement, outcome, correct, wrong,
           questions_reached, hearts_left, eliminated, eliminated_at_ms, mistake_times_ms, device, rating_before, rating_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        input.id, p.key, cur ? p.uid! : null, p.kind, p.name, p.placement, p.outcome, p.correct, p.wrong,
        p.questionsReached, p.heartsLeft, p.eliminatedAtMs !== null ? 1 : 0, p.eliminatedAtMs,
        JSON.stringify(p.mistakes), p.device, after !== undefined ? cur!.rating : null, after ?? null,
      ),
    );
    if (cur && p.uid) {
      const counted = input.mode !== "bot";
      stmts.push(
        env.DB.prepare(
          `UPDATE players SET
             rating = COALESCE(?, rating),
             rated_games = rated_games + ?,
             wins = wins + ?, losses = losses + ?, draws = draws + ?,
             total_correct = total_correct + ?,
             best_60 = CASE WHEN ? = 60 AND ? > best_60 THEN ? ELSE best_60 END
           WHERE uid = ?`,
        ).bind(
          after ?? null, after !== undefined ? 1 : 0,
          counted && p.outcome === "win" ? 1 : 0, counted && p.outcome === "loss" ? 1 : 0, counted && p.outcome === "draw" ? 1 : 0,
          counted ? p.correct : 0,
          input.duration, p.correct, p.correct, p.uid,
        ),
      );
    }
  }
  await env.DB.batch(stmts);
  const out = new Map<string, { before: number; after: number }>();
  if (next) for (const [uid, after] of next) out.set(uid, { before: current.get(uid)!.rating, after });
  return out;
}

export interface Profile {
  uid: string;
  username: string;
  provider: string;
  rating: number;
  rated_games: number;
  wins: number;
  losses: number;
  draws: number;
  total_correct: number;
  best_60: number;
  created_at: number;
}

export async function getProfile(env: Env, uid: string): Promise<Profile | null> {
  return env.DB.prepare("SELECT * FROM players WHERE uid = ?").bind(uid).first<Profile>();
}

export async function upsertProfile(env: Env, uid: string, username: string, provider: string): Promise<"ok" | "taken"> {
  try {
    await env.DB.prepare(
      `INSERT INTO players (uid, username, provider, rating, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET username = excluded.username`,
    )
      .bind(uid, username, provider, DEFAULT_RATING, Date.now())
      .run();
    return "ok";
  } catch (e) {
    if (String(e).includes("UNIQUE")) return "taken";
    throw e;
  }
}

export async function deleteAccount(env: Env, uid: string) {
  await env.DB.batch([
    env.DB.prepare("UPDATE match_players SET uid = NULL, username = 'deleted' WHERE uid = ?").bind(uid),
    env.DB.prepare("DELETE FROM players WHERE uid = ?").bind(uid),
  ]);
}
