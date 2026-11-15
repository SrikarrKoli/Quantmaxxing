export const DEFAULT_RATING = 1200;
export const PROVISIONAL_GAMES = 20;

export function expectedScore(rating: number, opponent: number): number {
  return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

export function kFactor(ratedGames: number): number {
  return ratedGames < PROVISIONAL_GAMES ? 40 : 20;
}

/** Elo update for one player. score: 1 win, 0.5 draw, 0 loss. */
export function eloUpdate(rating: number, opponent: number, score: number, ratedGames: number): number {
  const next = rating + kFactor(ratedGames) * (score - expectedScore(rating, opponent));
  return Math.round(next * 10) / 10;
}

/** Level from lifetime correct answers in non-bot matches. Level 1 at 0. */
export function levelFor(totalCorrect: number): number {
  return Math.floor(Math.sqrt(Math.max(0, totalCorrect) / 25)) + 1;
}
