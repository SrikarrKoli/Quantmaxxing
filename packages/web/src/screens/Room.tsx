import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  DURATIONS, STARTING_HEARTS, answerOf, formatQuestion,
  type DurationSec, type MatchResults, type ProgressState, type Question, type RoomSnapshot, type SelfState, type ServerMsg,
} from "@qm/shared";
import { api, wsUrl } from "../api";
import { Link, navigate } from "../router";
import { errorText, useSession } from "../session";
import { GuestNameDialog } from "./Home";

interface MatchInfo { matchId: string; startAt: number; endAt: number; duration: DurationSec }

const device = () => (window.matchMedia("(pointer: coarse)").matches ? "touch" : "keyboard");
const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function RoomScreen({ roomId }: { roomId: string }) {
  const s = useSession();
  const [needName, setNeedName] = useState(false);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [match, setMatch] = useState<MatchInfo | null>(null);
  const [self, setSelf] = useState<SelfState | null>(null);
  const [progress, setProgress] = useState<Record<string, ProgressState>>({});
  const [results, setResults] = useState<MatchResults | null>(null);
  const [index, setIndex] = useState(0);
  const [value, setValue] = useState("");
  const [shake, setShake] = useState(0);
  const [now, setNow] = useState(Date.now());
  const questions = useRef(new Map<number, Question>());
  const offset = useRef(0);
  const ws = useRef<WebSocket | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [attempt, setAttempt] = useState(0);

  const send = useCallback((m: object) => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify(m)), []);

  useEffect(() => {
    let cancelled = false;
    let sock: WebSocket | null = null;
    (async () => {
      const auth = await s.authHeaders();
      if (!auth) { setNeedName(true); return; }
      setStatus("connecting");
      let ticket: string;
      try {
        ticket = (await api<{ ticket: string }>("/api/ticket", { method: "POST", auth })).ticket;
      } catch (e) { setError(errorText(e)); setStatus("closed"); return; }
      if (cancelled) return;
      sock = new WebSocket(wsUrl(`/ws/room/${roomId}?ticket=${encodeURIComponent(ticket)}`));
      ws.current = sock;
      sock.onopen = () => { setStatus("open"); sock!.send(JSON.stringify({ t: "hello", device: device() })); };
      sock.onclose = (e) => {
        if (cancelled) return;
        setStatus("closed");
        if (e.code === 4404 || e.code === 1008) setError(e.reason || "That room doesn't exist or is full.");
      };
      sock.onerror = () => !cancelled && setError("Couldn't connect to the room. Check the code or try again.");
      sock.onmessage = (ev) => {
        const m = JSON.parse(ev.data as string) as ServerMsg;
        switch (m.t) {
          case "room": setRoom(m.room); break;
          case "match":
            offset.current = m.serverNow - Date.now();
            questions.current = new Map(m.questions.map((q) => [q.index, q]));
            setMatch({ matchId: m.matchId, startAt: m.startAt, endAt: m.endAt, duration: m.duration });
            setSelf(m.self); setIndex(m.self?.index ?? 0); setValue(""); setResults(null);
            setProgress(Object.fromEntries(m.progress.map((p) => [p.key, p])));
            break;
          case "q": for (const q of m.questions) questions.current.set(q.index, q); break;
          case "ack":
            setSelf(m.self);
            setIndex((i) => Math.max(i, m.self.index));
            if (!m.ok) setShake((n) => n + 1);
            break;
          case "progress": setProgress((p) => ({ ...p, [m.p.key]: m.p })); break;
          case "results": setResults(m.results); break;
          case "error": setError(m.message); break;
        }
      };
    })();
    return () => { cancelled = true; sock?.close(1000, "unmount"); ws.current = null; };
  }, [roomId, attempt, s.profile?.uid ?? s.guest?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const serverNow = now + offset.current;
  const playing = !!match && !results && serverNow >= match.startAt;
  const counting = !!match && !results && serverNow < match.startAt;

  useEffect(() => {
    if (!match || results) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [match, results]);

  useEffect(() => { if (playing) input.current?.focus(); }, [playing]);

  if (needName) return <main className="page narrow"><GuestNameDialog onDone={() => { setNeedName(false); setAttempt((a) => a + 1); }} onCancel={() => navigate("/")} /></main>;

  const current = questions.current.get(index);
  const out = !self || self.eliminated;

  const onChange = (raw: string) => {
    const v = raw.replace(/[^0-9]/g, "").slice(0, 7);
    setValue(v);
    if (!playing || out || !current || v === "") return;
    if (Number(v) === answerOf(current)) {
      send({ t: "ans", i: current.index, v: Number(v) });
      setIndex(current.index + 1);
      setValue("");
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || !playing || out || !current || value === "") return;
    send({ t: "ans", i: current.index, v: Number(value) });
    setValue("");
  };

  const me = room?.you;
  const players = room?.players ?? [];
  const nameOf = (key: string) => players.find((p) => p.key === key)?.name ?? (key === "bot" ? "Bot" : "Player");

  if (error && !room) {
    return (
      <main className="page narrow">
        <h1>Can't join this match</h1>
        <p className="error" role="alert">{error}</p>
        <p><Link to="/">Back to the home screen</Link></p>
      </main>
    );
  }
  if (!room) return <main className="page narrow" aria-busy="true"><p>Connecting to the room…</p></main>;

  if (results) return <Results results={results} me={me} room={room} onRematch={() => send({ t: "start" })} />;

  if (match && (counting || playing)) {
    const remaining = match.endAt - serverNow;
    const others = Object.values(progress).filter((p) => p.key !== me);
    return (
      <main className="page match">
        <div className="hud">
          <span className="clock" aria-live="off">{counting ? fmtClock(match.endAt - match.startAt) : fmtClock(remaining)}</span>
          <span className="hearts" aria-label={`${self?.hearts ?? 0} of ${STARTING_HEARTS} hearts left`}>
            {Array.from({ length: STARTING_HEARTS }, (_, i) => <span key={i} className={i < (self?.hearts ?? 0) ? "heart" : "heart off"}>♥</span>)}
          </span>
        </div>
        <div className="stage">
          {counting ? (
            <p className="q" aria-live="assertive">{Math.ceil((match.startAt - serverNow) / 1000)}</p>
          ) : out ? (
            <p className="q small">{self ? "Out of hearts" : "Watching"}</p>
          ) : (
            <p className="q" aria-live="polite">{current ? formatQuestion(current) : "…"}</p>
          )}
          <label className="sr" htmlFor="answer">Answer</label>
          <input
            id="answer" ref={input} key={shake} className={`answer${shake ? " wrong" : ""}`}
            value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey}
            inputMode="numeric" autoComplete="off" autoCorrect="off" spellCheck={false}
            disabled={!playing || out} aria-describedby="answer-help"
          />
          <p id="answer-help" className="hint">Correct answers submit themselves. Press Enter to commit a different answer; wrong answers cost a heart.</p>
        </div>
        <div className="race">
          <div className="lane you"><span>You</span><b>{self?.correct ?? 0}</b></div>
          {others.map((p) => (
            <div key={p.key} className={`lane${p.eliminated ? " out" : ""}`}><span>{nameOf(p.key)}</span><b>{p.correct}</b></div>
          ))}
        </div>
        <button className="btn ghost resign" onClick={() => send({ t: "resign" })} disabled={!playing || out}>Resign</button>
      </main>
    );
  }

  return <Lobby room={room} status={status} error={error} onStart={() => { setError(null); send({ t: "start" }); }} onDuration={(d) => send({ t: "setDuration", duration: d })} onRetry={() => setAttempt((a) => a + 1)} />;
}

function Lobby({ room, status, error, onStart, onDuration, onRetry }: {
  room: RoomSnapshot; status: string; error: string | null; onStart: () => void; onDuration: (d: DurationSec) => void; onRetry: () => void;
}) {
  const host = room.hostKey === room.you;
  const link = `${window.location.origin}/r/${room.code ?? ""}`;
  const [copied, setCopied] = useState(false);
  if (room.mode !== "private") return <main className="page narrow" aria-busy="true"><p>Waiting for the match to start…</p></main>;
  const connected = room.players.filter((p) => p.connected);
  return (
    <main className="page lobby">
      <section className="panel">
        <h1>Private room</h1>
        <p>Room code</p>
        <p className="code">{room.code}</p>
        <button className="btn" onClick={async () => { await navigator.clipboard.writeText(link); setCopied(true); }}>{copied ? "Link copied" : "Copy invite link"}</button>
        <p className="hint">Rooms are never rated.</p>
      </section>
      <section className="panel">
        <h2>Players {connected.length} / 8</h2>
        <ul className="plist">
          {room.players.map((p) => (
            <li key={p.key}><span>{p.name}{p.key === room.you ? " (you)" : ""}</span><span className="hint">{p.key === room.hostKey ? "Host" : p.connected ? "Ready" : "Away"}</span></li>
          ))}
        </ul>
        <div className="seg" role="radiogroup" aria-label="Match length">
          {DURATIONS.map((d) => (
            <button key={d} role="radio" aria-checked={room.duration === d} className={room.duration === d ? "on" : ""} disabled={!host} onClick={() => onDuration(d)}>
              {d < 60 ? `${d} s` : `${d / 60} min`}
            </button>
          ))}
        </div>
        {host ? (
          <button className="btn primary" onClick={onStart} disabled={connected.length < 2}>{connected.length < 2 ? "Waiting for players" : "Start match"}</button>
        ) : (
          <p>Waiting for the host to start.</p>
        )}
        {status === "closed" && <p className="error">Connection lost. <button className="link" onClick={onRetry}>Reconnect</button></p>}
        {error && <p className="error" role="alert">{error}</p>}
      </section>
    </main>
  );
}

function Results({ results, me, room, onRematch }: { results: MatchResults; me?: string; room: RoomSnapshot; onRematch: () => void }) {
  const mine = results.rows.find((r) => r.key === me);
  const headline = !mine ? "Match over" : mine.outcome === "win" ? "You won" : mine.outcome === "draw" ? "Draw" : "You lost";
  const reason = { time: "Time ran out.", hearts: "A player ran out of hearts.", resign: "A player resigned.", abandoned: "A player left." }[results.endReason];
  const s = useSession();
  const again = async () => {
    if (results.mode === "private") return onRematch();
    if (results.mode === "bot") {
      const auth = await s.authHeaders();
      if (!auth) return;
      const r = await api<{ roomId: string }>("/api/bot", { method: "POST", body: { duration: results.duration, level: room.botLevel }, auth });
      return navigate(`/m/${r.roomId}`);
    }
    navigate(results.mode === "ranked" ? "/queue/ranked" : `/queue/casual?d=${results.duration}`);
  };
  const host = room.hostKey === me;
  return (
    <main className="page results">
      <h1>{headline}</h1>
      <p className="hint">{reason} {results.rated ? "Rated match." : "Unrated."}</p>
      <table>
        <thead><tr><th scope="col">Place</th><th scope="col">Player</th><th scope="col">Correct</th><th scope="col">Wrong</th><th scope="col">Hearts</th>{results.rated && <th scope="col">Rating</th>}</tr></thead>
        <tbody>
          {results.rows.map((r) => (
            <tr key={r.key} className={r.key === me ? "me" : ""}>
              <td>{r.placement}</td><td>{r.name}</td><td>{r.correct}</td><td>{r.wrong}</td><td>{r.eliminated ? "Out" : r.hearts}</td>
              {results.rated && <td>{r.ratingAfter !== undefined && r.ratingBefore !== undefined ? `${Math.round(r.ratingAfter)} (${r.ratingAfter >= r.ratingBefore ? "+" : ""}${(r.ratingAfter - r.ratingBefore).toFixed(1)})` : "–"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        {results.mode === "private" && !host ? <p>Waiting for the host to start a rematch.</p> : (
          <button className="btn primary" onClick={again}>{results.mode === "private" ? "Rematch" : results.mode === "bot" ? "Play again" : "Find another match"}</button>
        )}
        <Link to="/" className="btn ghost">Home</Link>
      </div>
    </main>
  );
}
