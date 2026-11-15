import { describe, expect, it } from "vitest";
import {
  botLevelFor, botPacePerMin,
  answerOf, botSchedule, botStateAt, compareStandings, eloUpdate, levelFor, parseClientMsg,
  placements, questionAt, suggestUsername, validateUsername, resultShareText, isEventName, cleanSource, type Standing,
} from "../src";

const base = (o: Partial<Standing> & { key: string }): Standing => ({
  correct: 0, wrong: 0, eliminated: false, eliminatedAtMs: null, lastCorrectAtMs: null, ...o,
});

describe("questions", () => {
  it("are deterministic and random-access for a seed", () => {
    for (let i = 0; i < 200; i++) expect(questionAt("seed-a", i)).toEqual(questionAt("seed-a", i));
    const a = Array.from({ length: 50 }, (_, i) => questionAt("seed-a", i));
    const b = Array.from({ length: 50 }, (_, i) => questionAt("seed-b", i));
    expect(a).not.toEqual(b);
  });
  it("always have positive integer answers within Zetamac ranges", () => {
    for (let i = 0; i < 2000; i++) {
      const q = questionAt("range", i);
      const ans = answerOf(q);
      expect(Number.isInteger(ans)).toBe(true);
      expect(ans).toBeGreaterThan(0);
      if (q.op === "+") expect(Math.max(q.a, q.b)).toBeLessThanOrEqual(100);
      if (q.op === "×") expect(Math.min(q.a, q.b)).toBeLessThanOrEqual(12);
    }
  });
});

describe("standings", () => {
  it("ranks by correct, then fewer wrong, then earlier finish", () => {
    expect(compareStandings(base({ key: "a", correct: 10 }), base({ key: "b", correct: 9 }))).toBeLessThan(0);
    expect(compareStandings(base({ key: "a", correct: 9, wrong: 2 }), base({ key: "b", correct: 9, wrong: 0 }))).toBeGreaterThan(0);
    expect(compareStandings(
      base({ key: "a", correct: 9, lastCorrectAtMs: 500 }),
      base({ key: "b", correct: 9, lastCorrectAtMs: 400 }),
    )).toBeGreaterThan(0);
  });
  it("puts eliminated players below alive players regardless of score", () => {
    const p = placements([
      base({ key: "fast", correct: 30, wrong: 3, eliminated: true, eliminatedAtMs: 20000 }),
      base({ key: "slow", correct: 5 }),
    ]);
    expect(p.get("slow")).toBe(1);
    expect(p.get("fast")).toBe(2);
  });
  it("shares placements for exact ties", () => {
    const p = placements([base({ key: "a", correct: 3, lastCorrectAtMs: 10 }), base({ key: "b", correct: 3, lastCorrectAtMs: 10 })]);
    expect(p.get("a")).toBe(1);
    expect(p.get("b")).toBe(1);
  });
  it("ranks later elimination higher among eliminated players", () => {
    const p = placements([
      base({ key: "early", correct: 20, eliminated: true, eliminatedAtMs: 1000 }),
      base({ key: "late", correct: 2, eliminated: true, eliminatedAtMs: 9000 }),
    ]);
    expect(p.get("late")).toBe(1);
  });
});

describe("rating", () => {
  it("is zero-sum for equal K and moves toward the result", () => {
    const a = eloUpdate(1200, 1200, 1, 30);
    const b = eloUpdate(1200, 1200, 0, 30);
    expect(a).toBe(1210);
    expect(b).toBe(1190);
    expect(eloUpdate(1200, 1200, 0.5, 0)).toBe(1200);
    expect(eloUpdate(1200, 1200, 1, 0)).toBe(1220);
  });
  it("computes levels", () => {
    expect(levelFor(0)).toBe(1);
    expect(levelFor(25)).toBe(2);
    expect(levelFor(100)).toBe(3);
  });
});

describe("bot", () => {
  it("is deterministic and never makes a third mistake", () => {
    for (const level of ["easy", "medium", "hard", "expert"] as const) {
      const s = botSchedule("x", level, 120000);
      expect(s).toEqual(botSchedule("x", level, 120000));
      expect(s.filter((e) => e.kind === "wrong").length).toBeLessThanOrEqual(2);
      expect(s.every((e) => e.atMs < 120000)).toBe(true);
    }
    const s = botSchedule("y", "hard", 60000);
    expect(botStateAt(s, 60000).correct).toBeGreaterThan(30);
    expect(botStateAt(s, 0).correct).toBe(0);
  });
});

describe("names and protocol", () => {
  it("suggests valid usernames", () => {
    for (let i = 0; i < 100; i++) expect(validateUsername(suggestUsername()).ok).toBe(true);
  });
  it("rejects bad usernames", () => {
    expect(validateUsername("ab").ok).toBe(false);
    expect(validateUsername("has space").ok).toBe(false);
    expect(validateUsername("Admin_1").ok).toBe(false);
    expect(validateUsername("  Neat_Name ")).toEqual({ ok: true, name: "Neat_Name" });
  });
  it("parses only well-formed client messages", () => {
    expect(parseClientMsg('{"t":"ans","i":3,"v":42}')).toEqual({ t: "ans", i: 3, v: 42 });
    expect(parseClientMsg('{"t":"ans","i":1.5,"v":42}')).toBeNull();
    expect(parseClientMsg("not json")).toBeNull();
    expect(parseClientMsg('{"t":"nope"}')).toBeNull();
    expect(parseClientMsg("x".repeat(600))).toBeNull();
  });
});

describe("bot fill", () => {
  it("picks the bot level closest to the player's pace, then rating, then Easy", () => {
    expect(botLevelFor({})).toBe("easy");
    expect(botLevelFor({ rating: 1200 })).toBe("medium");
    expect(botLevelFor({ rating: 1600 })).toBe("expert");
    expect(botLevelFor({ pace: 20, rating: 1600 })).toBe("easy");
    expect(botLevelFor({ pace: 47 })).toBe("hard");
    expect(botLevelFor({ pace: 120 })).toBe("expert");
    expect(botLevelFor({ pace: Number.NaN })).toBe("easy");
  });
  it("estimates bot pace close to the real schedule", () => {
    for (const level of ["easy", "medium", "hard", "expert"] as const) {
      const real = botStateAt(botSchedule("pace", level, 60000), 60000).correct;
      expect(Math.abs(real - botPacePerMin(level)) / real).toBeLessThan(0.25);
    }
  });
  it("reserves bot names", () => {
    for (const n of ["Bot", "Medium_Bot", "easy-bot", "EXPERTBOT", "Quant_Trader"]) expect(validateUsername(n).ok).toBe(false);
    expect(validateUsername("Talbot").ok).toBe(true);
  });
});

describe("sharing and events", () => {
  it("builds a plain result card", () => {
    expect(resultShareText({ outcome: "win", correct: 24, wrong: 1, hearts: 2, durationSec: 60, opponent: { name: "Quant Trader", correct: 19 } }))
      .toBe("Quantmaxxing · 1 min\nBeat Quant Trader 24–19\n● ● ○  1 wrong\nhttps://quantmaxxing.web.app/?s=share");
    expect(resultShareText({ outcome: "practice", correct: 30, wrong: 0, hearts: 3, durationSec: 120 }, "http://x"))
      .toBe("Quantmaxxing · 2 min\n30 correct\n● ● ●  0 wrong\nhttp://x/?s=share");
    expect(resultShareText({ outcome: "loss", correct: 10, wrong: 3, hearts: 0, durationSec: 30, opponent: { name: "ann", correct: 12 }, rated: { delta: -14.4, after: 1185.6 } }))
      .toContain("Lost to ann 10–12 · Ranked −14 → 1186");
  });
  it("only accepts known events and short source tokens", () => {
    expect(isEventName("share")).toBe(true);
    expect(isEventName("drop table")).toBe(false);
    expect(cleanSource("www.Reddit.com")).toBe("reddit.com");
    expect(cleanSource("https://evil.example/?q=1")).toBe("direct");
    expect(cleanSource(undefined)).toBe("direct");
  });
});
