export const DURATIONS = [30, 60, 120] as const;
export type DurationSec = (typeof DURATIONS)[number];
export const RANKED_DURATION: DurationSec = 60;
export const STARTING_HEARTS = 3;
/** Questions revealed ahead of the player's current index. */
export const LOOKAHEAD = 3;
/** Submissions closer together than this are dropped (key-repeat / scripted spam). */
export const MIN_SUBMIT_GAP_MS = 60;
/** After a wrong answer, further wrong submissions in this window are ignored. */
export const WRONG_COOLDOWN_MS = 350;
/** Answers arriving this long after the clock hits zero still count (network grace). */
export const END_GRACE_MS = 150;
export const COUNTDOWN_MS = 3000;
export const MAX_ROOM_PLAYERS = 8;

export function isDuration(n: unknown): n is DurationSec {
  return typeof n === "number" && (DURATIONS as readonly number[]).includes(n);
}

export type EndReason = "time" | "hearts" | "resign" | "abandoned";

export interface Standing {
  key: string;
  correct: number;
  wrong: number;
  eliminated: boolean;
  /** ms since match start when eliminated (hearts or resign). */
  eliminatedAtMs: number | null;
  /** ms since match start when the player reached their final correct count. */
  lastCorrectAtMs: number | null;
}

/**
 * Ordering used everywhere (1v1, bot, rooms):
 * 1. Players still alive rank above eliminated players.
 * 2. Alive: more correct answers, then fewer wrong answers, then whoever reached
 *    their score first. Identical on all three is a draw.
 * 3. Eliminated: later elimination ranks higher, then more correct answers.
 */
export function compareStandings(x: Standing, y: Standing): number {
  if (x.eliminated !== y.eliminated) return x.eliminated ? 1 : -1;
  if (!x.eliminated) {
    if (x.correct !== y.correct) return y.correct - x.correct;
    if (x.wrong !== y.wrong) return x.wrong - y.wrong;
    const xt = x.lastCorrectAtMs ?? Infinity;
    const yt = y.lastCorrectAtMs ?? Infinity;
    if (xt !== yt) return xt - yt;
    return 0;
  }
  const xe = x.eliminatedAtMs ?? 0;
  const ye = y.eliminatedAtMs ?? 0;
  if (xe !== ye) return ye - xe;
  return y.correct - x.correct;
}

/** Returns 1-based placements; tied players share a placement. */
export function placements(standings: Standing[]): Map<string, number> {
  const sorted = [...standings].sort(compareStandings);
  const out = new Map<string, number>();
  sorted.forEach((s, i) => {
    const prev = sorted[i - 1];
    if (prev && compareStandings(prev, s) === 0) out.set(s.key, out.get(prev.key)!);
    else out.set(s.key, i + 1);
  });
  return out;
}
