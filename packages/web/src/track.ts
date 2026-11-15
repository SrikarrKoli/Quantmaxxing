import { cleanSource, type EventName } from "@qm/shared";

const ORIGIN = (import.meta.env.VITE_API_ORIGIN as string | undefined) || "";
const SRC_KEY = "qm.src";
const SEEN_KEY = "qm.firstVisit";
const LAST_KEY = "qm.lastVisit";

/** Where this visit came from: ?s=, ?ref= or ?utm_source=, else the referring site, else "direct". */
function source(): string {
  const saved = sessionStorage.getItem(SRC_KEY);
  if (saved) return saved;
  const q = new URLSearchParams(window.location.search);
  let src = q.get("s") ?? q.get("ref") ?? q.get("utm_source");
  if (!src && document.referrer) {
    try {
      const host = new URL(document.referrer).hostname;
      if (host !== window.location.hostname) src = host;
    } catch { /* ignore */ }
  }
  const clean = cleanSource(src);
  sessionStorage.setItem(SRC_KEY, clean);
  return clean;
}

/** Anonymous daily counter. No ids, cookies or personal data are sent. */
export function track(name: EventName) {
  try {
    const body = JSON.stringify({ name, src: source() });
    const url = `${ORIGIN}/api/event`;
    if (!navigator.sendBeacon?.(url, new Blob([body], { type: "text/plain" }))) {
      void fetch(url, { method: "POST", body, keepalive: true }).catch(() => {});
    }
  } catch { /* analytics must never break the game */ }
}

/** Counts each browser once per UTC day, as new or returning. */
export function trackVisit() {
  try {
    source();
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem(LAST_KEY) === today) return;
    const returning = !!localStorage.getItem(SEEN_KEY);
    if (!returning) localStorage.setItem(SEEN_KEY, today);
    localStorage.setItem(LAST_KEY, today);
    track(returning ? "visit_return" : "visit_new");
  } catch { /* storage can be blocked */ }
}
