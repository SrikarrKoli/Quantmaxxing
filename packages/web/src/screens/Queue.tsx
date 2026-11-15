import { useEffect, useState } from "react";
import { RANKED_DURATION, botLevelFor, isDuration, type LobbyServerMsg } from "@qm/shared";
import { api, wsUrl } from "../api";
import { Link, navigate } from "../router";
import { errorText, useSession } from "../session";
import { GuestNameDialog } from "./Home";
import { recentPace, storedPace } from "../pace";

export function Queue({ kind }: { kind: "casual" | "ranked" }) {
  const s = useSession();
  const d = Number(new URLSearchParams(window.location.search).get("d"));
  const duration = kind === "ranked" ? RANKED_DURATION : isDuration(d) ? d : 60;
  const [waiting, setWaiting] = useState<number | null>(null);
  const [botAt, setBotAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needName, setNeedName] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [since] = useState(Date.now());
  const [, tick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (kind === "ranked" && !s.profile) { navigate("/signin?next=/queue/ranked", true); return; }
    let cancelled = false;
    let sock: WebSocket | null = null;
    (async () => {
      const auth = await s.authHeaders();
      if (!auth) { setNeedName(true); return; }
      let ticket: string;
      try { ticket = (await api<{ ticket: string }>("/api/ticket", { method: "POST", auth })).ticket; }
      catch (e) { setError(errorText(e)); return; }
      if (cancelled) return;
      sock = new WebSocket(wsUrl(`/ws/lobby?queue=${kind}&duration=${duration}&ticket=${encodeURIComponent(ticket)}${recentPace()}`));
      sock.onmessage = (ev) => {
        const m = JSON.parse(ev.data as string) as LobbyServerMsg;
        if (m.t === "queued") { setWaiting(m.waiting); setBotAt(m.botInMs !== undefined ? Date.now() + m.botInMs : null); }
        else if (m.t === "matched") { cancelled = true; sock?.close(1000, "matched"); navigate(`/m/${m.roomId}${m.bot ? "?bot=1" : ""}`, true); }
        else if (m.t === "error") setError(m.message);
      };
      sock.onerror = () => !cancelled && setError("Lost connection to matchmaking.");
    })();
    return () => {
      cancelled = true;
      if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: "leave" }));
      sock?.close(1000, "left");
    };
  }, [kind, duration, attempt, s.profile]); // eslint-disable-line react-hooks/exhaustive-deps

  if (needName) return <main className="page narrow"><GuestNameDialog onDone={() => { setNeedName(false); setAttempt((a) => a + 1); }} onCancel={() => navigate("/")} /></main>;

  const secs = Math.floor((Date.now() - since) / 1000);
  const botIn = botAt === null ? null : Math.max(0, Math.ceil((botAt - Date.now()) / 1000));
  const playBot = async () => {
    const auth = await s.authHeaders();
    if (!auth) return;
    const level = botLevelFor({ pace: storedPace(), rating: s.profile?.rating });
    try {
      const r = await api<{ roomId: string }>("/api/bot", { method: "POST", body: { duration, level }, auth });
      navigate(`/m/${r.roomId}`, true);
    } catch (e) { setError(errorText(e)); }
  };
  return (
    <main className="page narrow center" aria-busy={!error}>
      <h1 style={{ marginTop: "2rem" }}>{kind === "ranked" ? "Ranked" : "Quick match"} · {duration < 60 ? `${duration} s` : `${duration / 60} min`}</h1>
      {error ? (
        <>
          <p className="error" role="alert">{error}</p>
          <button className="btn" onClick={() => { setError(null); setAttempt((a) => a + 1); }}>Try again</button>
        </>
      ) : (
        <p aria-live="polite">Looking for an opponent… {secs}s{waiting !== null && waiting > 1 ? ` · ${waiting} in queue` : ""}</p>
      )}
      {!error && botIn !== null && (
        <p className="hint" aria-live="polite">
          {botIn > 0 ? `No one else is here yet. Matching you with a bot in ${botIn}s.` : "Matching you with a bot…"}
          {kind === "ranked" ? " Bot games are unrated." : ""}
        </p>
      )}
      {!error && <p><button className="link" onClick={playBot}>Play a bot now</button></p>}
      <Link to="/" className="btn ghost">Cancel</Link>
    </main>
  );
}
