import { hashString, mulberry32, randInt } from "./rng";

export type Op = "+" | "-" | "×" | "÷";

export interface Question {
  index: number;
  a: number;
  b: number;
  op: Op;
}

/**
 * Zetamac-style defaults with a gentle ramp: the first questions are a little
 * smaller so a sprint starts smoothly, then ranges open up to the full set.
 * Addition: (2–100) + (2–100). Subtraction: addition reversed.
 * Multiplication: (2–12) × (2–100). Division: multiplication reversed.
 */
function ranges(index: number) {
  const ramp = Math.min(1, 0.45 + index * 0.055);
  return {
    addMax: Math.max(20, Math.round(100 * ramp)),
    mulSmallMax: Math.max(6, Math.round(12 * Math.min(1, 0.6 + index * 0.04))),
    mulLargeMax: Math.max(12, Math.round(100 * ramp)),
  };
}

/** Random-access: question `index` of `seed` is always the same, on every device. */
export function questionAt(seed: string, index: number): Question {
  const rng = mulberry32(hashString(`${seed}:${index}`));
  const r = ranges(index);
  const kind = Math.floor(rng() * 4);
  if (kind === 0) {
    return { index, a: randInt(rng, 2, r.addMax), b: randInt(rng, 2, r.addMax), op: "+" };
  }
  if (kind === 1) {
    const x = randInt(rng, 2, r.addMax);
    const y = randInt(rng, 2, r.addMax);
    return { index, a: x + y, b: x, op: "-" };
  }
  const small = randInt(rng, 2, r.mulSmallMax);
  const large = randInt(rng, 2, r.mulLargeMax);
  if (kind === 2) {
    return rng() < 0.5
      ? { index, a: small, b: large, op: "×" }
      : { index, a: large, b: small, op: "×" };
  }
  return { index, a: small * large, b: small, op: "÷" };
}

export function answerOf(q: Pick<Question, "a" | "b" | "op">): number {
  switch (q.op) {
    case "+":
      return q.a + q.b;
    case "-":
      return q.a - q.b;
    case "×":
      return q.a * q.b;
    case "÷":
      return q.a / q.b;
  }
}

export function formatQuestion(q: Pick<Question, "a" | "b" | "op">): string {
  const op = q.op === "-" ? "−" : q.op;
  return `${q.a} ${op} ${q.b}`;
}
