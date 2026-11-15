import { hashString, mulberry32 } from "./rng";

export const BOT_LEVELS = {
  easy: { label: "Easy", meanMs: 2600, jitter: 0.45, wrongRate: 0.05 },
  medium: { label: "Medium", meanMs: 1700, jitter: 0.4, wrongRate: 0.04 },
  hard: { label: "Hard", meanMs: 1150, jitter: 0.35, wrongRate: 0.03 },
  expert: { label: "Expert", meanMs: 800, jitter: 0.3, wrongRate: 0.02 },
} as const;
export type BotLevel = keyof typeof BOT_LEVELS;

export function isBotLevel(v: unknown): v is BotLevel {
  return typeof v === "string" && v in BOT_LEVELS;
}

export interface BotEvent {
  atMs: number;
  kind: "correct" | "wrong";
}

/**
 * The bot's whole match is a pure function of (seed, level, duration) so the
 * server can compute its state at any instant without storing per-answer
 * writes. Bots never make a third mistake.
 */
export function botSchedule(seed: string, level: BotLevel, durationMs: number): BotEvent[] {
  const cfg = BOT_LEVELS[level];
  const rng = mulberry32(hashString(`bot:${seed}:${level}`));
  const events: BotEvent[] = [];
  let t = 0;
  let wrong = 0;
  let index = 0;
  while (t < durationMs) {
    // Later questions are a bit larger, so slow down slightly as the sprint goes on.
    const ramp = 1 + Math.min(0.25, index * 0.006);
    const step = cfg.meanMs * ramp * (1 + (rng() * 2 - 1) * cfg.jitter);
    t += Math.max(250, step);
    if (t >= durationMs) break;
    if (wrong < 2 && rng() < cfg.wrongRate) {
      wrong++;
      events.push({ atMs: Math.round(t), kind: "wrong" });
      t += 400;
      continue;
    }
    events.push({ atMs: Math.round(t), kind: "correct" });
    index++;
  }
  return events;
}

export function botStateAt(events: BotEvent[], elapsedMs: number) {
  let correct = 0;
  let wrong = 0;
  let lastCorrectAtMs: number | null = null;
  for (const e of events) {
    if (e.atMs > elapsedMs) break;
    if (e.kind === "correct") {
      correct++;
      lastCorrectAtMs = e.atMs;
    } else wrong++;
  }
  return { correct, wrong, lastCorrectAtMs };
}

/** Rough correct answers per minute a bot level reaches (the schedule slows ~12% on average). */
export function botPacePerMin(level: BotLevel): number {
  return 60_000 / (BOT_LEVELS[level].meanMs * 1.12);
}

/**
 * Pick the bot level most likely to give a close game: the player's recent pace
 * (correct per minute) when known, otherwise their rating, otherwise Easy.
 */
export function botLevelFor(p: { pace?: number; rating?: number }): BotLevel {
  const levels = Object.keys(BOT_LEVELS) as BotLevel[];
  if (p.pace !== undefined && Number.isFinite(p.pace) && p.pace > 0) {
    return levels.reduce((best, l) => (Math.abs(botPacePerMin(l) - p.pace!) < Math.abs(botPacePerMin(best) - p.pace!) ? l : best));
  }
  if (p.rating !== undefined) return p.rating < 1150 ? "easy" : p.rating < 1300 ? "medium" : p.rating < 1450 ? "hard" : "expert";
  return "easy";
}
