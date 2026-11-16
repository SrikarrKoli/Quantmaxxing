import type { Mode } from "./protocol";
import { isDuration } from "./rules";

export type RunMode = Mode | "practice";

/** One finished match or solo run from the player's point of view. */
export interface RunRecord {
  id: string;
  mode: RunMode;
  duration: number;
  correct: number;
  wrong: number;
  /** Epoch ms when the run ended. */
  at: number;
  outcome?: "win" | "loss" | "draw";
  opponent?: string;
}

export interface PracticeRunInput {
  duration: number;
  correct: number;
  wrong: number;
  at: number;
}

const MAX_PER_SEC = 5;
const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** Validates a client-reported solo run. Solo runs only appear in the player's own history, never on leaderboards. */
export function cleanPracticeRun(raw: unknown, now: number): PracticeRunInput | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const { duration, correct, wrong } = o;
  const at = o.at === undefined ? now : o.at;
  if (!isDuration(duration)) return null;
  const int = (n: unknown, max: number): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= max;
  if (!int(correct, duration * MAX_PER_SEC) || !int(wrong, duration * MAX_PER_SEC)) return null;
  if (typeof at !== "number" || !Number.isFinite(at) || at > now + 60_000 || at < now - MAX_AGE_MS) return null;
  return { duration, correct, wrong, at: Math.round(at) };
}

export interface RunWithChange extends RunRecord {
  /** Correct answers compared with the previous run of the same length; null for the first. */
  change: number | null;
  /** Beat every earlier run of the same length. */
  best: boolean;
}

/** Oldest first, each run compared with the previous run of the same length. */
export function withChanges(runs: RunRecord[]): RunWithChange[] {
  const last = new Map<number, number>();
  const top = new Map<number, number>();
  return [...runs].sort((a, b) => a.at - b.at).map((r) => {
    const prev = last.get(r.duration);
    const hi = top.get(r.duration);
    last.set(r.duration, r.correct);
    top.set(r.duration, Math.max(hi ?? 0, r.correct));
    return { ...r, change: prev === undefined ? null : r.correct - prev, best: hi !== undefined && r.correct > hi };
  });
}

export interface LengthSummary {
  duration: number;
  runs: number;
  first: number;
  latest: number;
  best: number;
  average: number;
}

/** Per match length: how many runs, first vs latest score, best and average. Most-played length first. */
export function summarizeRuns(runs: RunRecord[]): LengthSummary[] {
  const by = new Map<number, RunRecord[]>();
  for (const r of [...runs].sort((a, b) => a.at - b.at)) by.set(r.duration, [...(by.get(r.duration) ?? []), r]);
  return [...by.entries()]
    .map(([duration, rs]) => ({
      duration,
      runs: rs.length,
      first: rs[0]!.correct,
      latest: rs[rs.length - 1]!.correct,
      best: Math.max(...rs.map((r) => r.correct)),
      average: Math.round((rs.reduce((n, r) => n + r.correct, 0) / rs.length) * 10) / 10,
    }))
    .sort((a, b) => b.runs - a.runs || a.duration - b.duration);
}
