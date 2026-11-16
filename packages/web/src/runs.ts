import { useSyncExternalStore } from "react";
import type { RunRecord } from "@qm/shared";
import { api, type AuthHeaders } from "./api";

const KEY = "qm.runs";
const CHANGED = "qm-runs";

interface Stored extends RunRecord { synced?: boolean }

function read(): Stored[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as Stored[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function write(runs: Stored[]) {
  try { sessionStorage.setItem(KEY, JSON.stringify(runs.slice(-200))); } catch { /* storage full or blocked */ }
  cache = null;
  window.dispatchEvent(new Event(CHANGED));
}

let cache: Stored[] | null = null;
const snapshot = () => (cache ??= read());
const subscribe = (cb: () => void) => {
  window.addEventListener(CHANGED, cb);
  return () => window.removeEventListener(CHANGED, cb);
};

/** Runs from this browser tab's session (cleared when the tab closes). */
export function useSessionRuns(): RunRecord[] {
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * Remembers a finished run for this session. Signed-in players' solo runs are
 * also saved to their account; their matches are already saved by the server.
 */
export function addSessionRun(run: RunRecord, auth?: AuthHeaders | null) {
  const runs = read();
  if (runs.some((r) => r.id === run.id)) return;
  const stored: Stored = { ...run, synced: run.mode !== "practice" };
  write([...runs, stored]);
  if (run.mode === "practice" && auth?.Authorization) {
    api("/api/runs", { method: "POST", body: upload(run), auth })
      .then(() => markSynced([run.id]))
      .catch(() => { /* kept locally; uploaded with the next sign-in */ });
  }
}

const upload = (r: RunRecord) => ({ id: r.id, duration: r.duration, correct: r.correct, wrong: r.wrong, at: r.at });
/** Keeps each claim request well under the server's request size and per-request run limit. */
const CLAIM_BATCH = 20;

function markSynced(ids: string[]) {
  write(read().map((r) => (ids.includes(r.id) ? { ...r, synced: true } : r)));
}

/** After sign-in: attach this browser's guest matches and unsaved solo runs to the account. */
export async function claimGuestRuns(auth: AuthHeaders, guestToken: string | undefined) {
  const pending = read().filter((r) => r.mode === "practice" && !r.synced);
  if (!pending.length && !guestToken) return;
  let i = 0;
  do {
    const batch = pending.slice(i, i + CLAIM_BATCH);
    await api("/api/me/claim", {
      method: "POST",
      body: { practice: batch.map(upload) },
      auth: { ...auth, ...(guestToken && i === 0 ? { "X-Guest-Token": guestToken } : {}) },
    });
    markSynced(batch.map((r) => r.id));
    i += CLAIM_BATCH;
  } while (i < pending.length);
}
