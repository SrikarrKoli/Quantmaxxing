import { STARTING_HEARTS } from "./rules";

export const SITE_URL = "https://quantmaxxing.web.app";

export interface ShareInput {
  outcome?: "win" | "loss" | "draw" | "practice";
  correct: number;
  wrong: number;
  hearts: number;
  durationSec: number;
  opponent?: { name: string; correct: number };
  rated?: { delta: number; after: number };
}

const len = (d: number) => (d < 60 ? `${d}s` : `${d / 60} min`);

/** Plain-text result card for social posts. Monochrome by design: no emoji. */
export function resultShareText(r: ShareInput, url = SITE_URL): string {
  const hearts = Array.from({ length: STARTING_HEARTS }, (_, i) => (i < r.hearts ? "●" : "○")).join(" ");
  let line: string;
  if (r.opponent && r.outcome !== "practice") {
    const verb = r.outcome === "win" ? "Beat" : r.outcome === "draw" ? "Drew with" : "Lost to";
    line = `${verb} ${r.opponent.name} ${r.correct}–${r.opponent.correct}`;
  } else {
    line = `${r.correct} correct`;
  }
  const rated = r.rated ? ` · Ranked ${r.rated.delta >= 0 ? "+" : "−"}${Math.abs(Math.round(r.rated.delta))} → ${Math.round(r.rated.after)}` : "";
  return [`Quantmaxxing · ${len(r.durationSec)}`, `${line}${rated}`, `${hearts}  ${r.wrong} wrong`, `${url}/?s=share`].join("\n");
}

export const EVENT_NAMES = ["visit_new", "visit_return", "share", "invite_copy", "practice_start", "practice_finish"] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export function isEventName(x: unknown): x is EventName {
  return typeof x === "string" && (EVENT_NAMES as readonly string[]).includes(x);
}

/** Traffic source label: a short lowercase token, or "direct". Never a full URL or anything personal. */
export function cleanSource(x: unknown): string {
  if (typeof x !== "string") return "direct";
  const s = x.toLowerCase().replace(/^www\./, "").slice(0, 40);
  return /^[a-z0-9][a-z0-9.-]*$/.test(s) ? s : "direct";
}
