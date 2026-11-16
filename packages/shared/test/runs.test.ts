import { describe, expect, it } from "vitest";
import { cleanPracticeRun, summarizeRuns, withChanges, type RunRecord } from "../src";

const run = (id: string, at: number, correct: number, duration = 60): RunRecord =>
  ({ id, mode: "practice", duration, correct, wrong: 0, at });

describe("run history", () => {
  it("compares each run with the previous run of the same length", () => {
    const rs = withChanges([run("c", 3, 18), run("a", 1, 12), run("x", 2, 9, 30), run("b", 2, 15), run("d", 4, 16)]);
    expect(rs.map((r) => r.id)).toEqual(["a", "x", "b", "c", "d"]);
    expect(rs.map((r) => r.change)).toEqual([null, null, 3, 3, -2]);
    expect(rs.map((r) => r.best)).toEqual([false, false, true, true, false]);
  });

  it("summarizes first, latest, best and average per length", () => {
    const [one, half] = summarizeRuns([run("a", 1, 12), run("b", 2, 20), run("c", 3, 16), run("x", 2, 9, 30)]);
    expect(one).toEqual({ duration: 60, runs: 3, first: 12, latest: 16, best: 20, average: 16 });
    expect(half).toEqual({ duration: 30, runs: 1, first: 9, latest: 9, best: 9, average: 9 });
  });

  it("only accepts plausible solo runs", () => {
    const now = 1_000_000_000_000;
    expect(cleanPracticeRun({ duration: 60, correct: 20, wrong: 1 }, now)).toEqual({ duration: 60, correct: 20, wrong: 1, at: now });
    expect(cleanPracticeRun({ duration: 45, correct: 20, wrong: 1 }, now)).toBeNull();
    expect(cleanPracticeRun({ duration: 60, correct: 301, wrong: 0 }, now)).toBeNull();
    expect(cleanPracticeRun({ duration: 60, correct: 1.5, wrong: 0 }, now)).toBeNull();
    expect(cleanPracticeRun({ duration: 60, correct: -1, wrong: 0 }, now)).toBeNull();
    expect(cleanPracticeRun({ duration: 60, correct: 5, wrong: 0, at: now + 3_600_000 }, now)).toBeNull();
    expect(cleanPracticeRun({ duration: 60, correct: 5, wrong: 0, at: now - 3 * 86_400_000 }, now)).toBeNull();
    expect(cleanPracticeRun("nope", now)).toBeNull();
  });
});

describe("cleanPracticeRun ids", () => {
  it("keeps a well-formed browser id and drops a malformed one", () => {
    const now = Date.now();
    expect(cleanPracticeRun({ id: "p:abc-123", duration: 60, correct: 5, wrong: 0, at: now }, now)?.id).toBe("p:abc-123");
    expect(cleanPracticeRun({ id: "x'; DROP", duration: 60, correct: 5, wrong: 0, at: now }, now)?.id).toBeUndefined();
  });
});
