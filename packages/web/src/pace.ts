import { isDuration } from "@qm/shared";

const KEY = "qm.pace";

/** Correct answers per minute from the player's last finished match, used to pick a fair bot. */
export function storedPace(): number | undefined {
  const n = Number(localStorage.getItem(KEY));
  return n > 0 && n < 200 ? n : undefined;
}

export function savePace(correct: number, durationSec: number) {
  if (!isDuration(durationSec) || correct < 0) return;
  localStorage.setItem(KEY, (correct / (durationSec / 60)).toFixed(1));
}

export function recentPace(): string {
  const p = storedPace();
  return p ? `&pace=${p}` : "";
}
