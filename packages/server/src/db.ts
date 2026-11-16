import { DEFAULT_RATING, summarizeRuns, type Device, type LengthSummary, type PracticeRunInput, type RunRecord, type EndReason, type Mode, type PlayerKind, type ResultRow } from "@qm/shared";
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
const DAY_MS = 24 * 60 * 60 * 1000;

/** Share of correct answers credited as XP for the nth bot-filled game in 24 hours. */
export function botXpShare(gamesToday: number): number {
  return gamesToday < 5 ? 1 : gamesToday < 10 ? 0.5 : 0;
}

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
  // Bot-filled queue games count toward XP on a daily taper so levels can't be farmed against bots.
  const botFill = input.mode !== "bot" && input.players.some((p) => p.kind === "bot");
  const botGamesToday = new Map<string, number>();
  if (botFill) {
    for (const uid of uids) {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM match_players me
           JOIN match_players b ON b.match_id = me.match_id AND b.kind = 'bot'
           JOIN matches m ON m.id = me.match_id
         WHERE me.uid = ? AND m.mode != 'bot' AND m.started_at > ?`,
      ).bind(uid, input.startedAt - DAY_MS).first<{ n: number }>();
      botGamesToday.set(uid, Number(row?.n ?? 0));
    }
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
        p.questionsReached, 0, p.eliminatedAtMs !== null ? 1 : 0, p.eliminatedAtMs,
        JSON.stringify(p.mistakes), p.device, after !== undefined ? cur!.rating : null, after ?? null,
      ),
    );
    if (cur && p.uid) {
      const counted = input.mode !== "bot" && !botFill;
      const xp = input.mode === "bot" ? 0 : botFill ? Math.floor(p.correct * botXpShare(botGamesToday.get(p.uid) ?? 0)) : p.correct;
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
          xp,
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
    env.DB.prepare("DELETE FROM practice_runs WHERE uid = ?").bind(uid),
    env.DB.prepare("DELETE FROM players WHERE uid = ?").bind(uid),
  ]);
}

export async function insertPracticeRuns(env: Env, uid: string, runs: PracticeRunInput[]) {
  if (!runs.length) return;
  await env.DB.batch(runs.map((r) =>
    env.DB.prepare("INSERT OR IGNORE INTO practice_runs (uid, duration_s, correct, wrong, created_at, client_id) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(uid, r.duration, r.correct, r.wrong, r.at, r.id ?? null),
  ));
}

/** Per-length summary over every run on the account, not just the ones listRuns returns. */
export async function summarizeAllRuns(env: Env, uid: string): Promise<LengthSummary[]> {
  const rows = await env.DB.prepare(
    `SELECT m.duration_s AS duration, mp.correct AS correct, m.ended_at AS at
     FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE mp.uid = ?
     UNION ALL
     SELECT duration_s, correct, created_at FROM practice_runs WHERE uid = ?`,
  )
    .bind(uid, uid)
    .all<{ duration: number; correct: number; at: number }>();
  return summarizeRuns(rows.results);
}

/** The latest matches and solo runs for one account, newest first. */
export async function listRuns(env: Env, uid: string, limit = 500): Promise<RunRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM (
       SELECT 'm:' || m.id AS id, m.mode AS mode, m.duration_s AS duration, mp.correct AS correct, mp.wrong AS wrong,
              m.ended_at AS at, mp.outcome AS outcome,
              CASE WHEN m.player_count = 2 THEN (SELECT o.username FROM match_players o
                WHERE o.match_id = mp.match_id AND o.player_key != mp.player_key LIMIT 1) END AS opponent
       FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE mp.uid = ?
       UNION ALL
       SELECT 'p:' || id, 'practice', duration_s, correct, wrong, created_at, NULL, NULL FROM practice_runs WHERE uid = ?
     ) ORDER BY at DESC LIMIT ?`,
  )
    .bind(uid, uid, limit)
    .all<RunRecord & { outcome: RunRecord["outcome"] | null; opponent: string | null }>();
  return rows.results.map(({ outcome, opponent, ...r }) => ({ ...r, ...(outcome ? { outcome } : {}), ...(opponent ? { opponent } : {}) }));
}
