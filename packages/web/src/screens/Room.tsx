import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  DURATIONS, answerOf, formatQuestion, questionAt, resultShareText,
  type DurationSec, type MatchResults, type ProgressState, type Question, type RoomSnapshot, type SelfState, type ServerMsg,
} from "@qm/shared";
import { api, wsUrl } from "../api";
import { Link, navigate } from "../router";
import { errorText, useSession } from "../session";
import { GuestNameDialog } from "./Home";
import { savePace } from "../pace";
import { ShareButton } from "../ShareButton";
import { track } from "../track";
import { addSessionRun } from "../runs";
import { RunProgress } from "./Runs";

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
  const [ticks, setTicks] = useState<Record<string, number[]>>({});
  const [miss, setMiss] = useState<string | null>(null);
  const startAt = useRef(0);
  const lastSent = useRef("");

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
            startAt.current = m.startAt;
            setTicks(Object.fromEntries(m.progress.map((p) => [p.key, []])));
            setMiss(null);
            setSelf(m.self); setIndex(m.self?.index ?? 0); setValue(""); setResults(null);
            setProgress(Object.fromEntries(m.progress.map((p) => [p.key, p])));
            break;
          case "q": for (const q of m.questions) questions.current.set(q.index, q); break;
          case "ack":
            setSelf(m.self);
            setIndex((i) => Math.max(i, m.self.index));
            if (!m.ok) { setShake((n) => n + 1); setMiss(lastSent.current); } else setMiss(null);
            break;
          case "progress": {
            const at = Date.now() + offset.current - startAt.current;
            setProgress((p) => ({ ...p, [m.p.key]: m.p }));
            setTicks((t) => {
              const prev = t[m.p.key] ?? [];
              if (m.p.correct <= prev.length) return t;
              return { ...t, [m.p.key]: [...prev, ...Array(m.p.correct - prev.length).fill(at)] };
            });
            break;
          }
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

  useEffect(() => { if (playing) input.current?.focus(); }, [playing, shake]);

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
    lastSent.current = value;
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
        {error.includes("Solo practice") && <p><Link to="/practice">Start solo practice</Link></p>}
        <p><Link to="/">Back to the home screen</Link></p>
      </main>
    );
  }
  if (!room) return <main className="page narrow" aria-busy="true"><p>Connecting to the room…</p></main>;

  if (results) return <Results results={results} me={me} room={room} ticks={ticks} questions={questions.current} onRematch={() => send({ t: "start" })} />;

  if (match && (counting || playing)) {
    const remaining = match.endAt - serverNow;
    const total = match.endAt - match.startAt;
    const elapsed = Math.max(0, serverNow - match.startAt);
    const others = Object.values(progress).filter((p) => p.key !== me);
    const mine = self?.correct ?? 0;
    const lead = others.length === 1 ? others[0]! : null;
    const lanes = [{ key: me ?? "you", name: "You", correct: mine, out: !!self?.eliminated, you: true },
      ...others.map((p) => ({ key: p.key, name: nameOf(p.key), correct: p.correct, out: p.eliminated, you: false }))];
    return (
      <main className="page match">
        <div className="hud">
          <div>
            <span aria-live="off">Time: {counting ? Math.round(total / 1000) : Math.max(0, Math.ceil(remaining / 1000))}</span>
          </div>
          {lead ? (
            <div className="vs" aria-label={`You ${mine}, ${nameOf(lead.key)} ${lead.correct}`}>
              {mine >= lead.correct && mine > 0 ? <b>You {mine}</b> : <>You {mine}</>}
              <span className="sep">·</span>
              {lead.correct > mine ? <b>{lead.correct} {nameOf(lead.key)}</b> : <>{lead.correct} {nameOf(lead.key)}</>}
            </div>
          ) : (
            <div className="vs">Score: <b>{mine}</b></div>
          )}
        </div>
        <div className="stage">
          {counting ? (
            <>
              <p className="q" aria-live="assertive">{Math.ceil((match.startAt - serverNow) / 1000)}</p>
              {room.mode !== "bot" && "bot" in progress && <p className="hint">No one's online right now, matched you with a bot.</p>}
            </>
          ) : out ? (
            <p className="q small">{self ? "Resigned" : "Watching"}</p>
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
          <p className="miss" aria-live="polite">
            {miss && !out ? <><s>{miss}</s>Wrong.</> : null}
          </p>
          <p id="answer-help" className="sr">Correct answers submit themselves. Press Enter to commit a different answer; a wrong answer keeps you on the same problem.</p>
        </div>
        <div className="tally" aria-hidden="true">
          {lanes.map((l) => (
            <div key={l.key} className={`lane${l.you ? "" : " them"}${l.out ? " out" : ""}`}>
              <span className="nm">{l.name}</span>
              <div className="track">
                {(ticks[l.key] ?? []).map((t, i) => <i key={i} style={{ left: `${Math.min(100, (t / total) * 100)}%` }} />)}
                {playing && <span className="now" style={{ left: `${Math.min(100, (elapsed / total) * 100)}%` }} />}
              </div>
              <span className="n">{l.correct}</span>
            </div>
          ))}
          <div className="axis"><span>0:00</span><span>{fmtClock(total / 2)}</span><span>{fmtClock(total)}</span></div>
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
    <main className="page center lobby">
      <p className="mute" style={{ marginTop: "1.5rem" }}>Private room</p>
      <p className="code">{room.code}</p>
      <p><button className="link" onClick={async () => { await navigator.clipboard.writeText(link); setCopied(true); track("invite_copy"); }}>{copied ? "Link copied" : "Copy invite link"}</button></p>
      <div className="seg" role="radiogroup" aria-label="Match length" style={{ margin: "1rem 0 .5rem" }}>
        {DURATIONS.map((d) => (
          <button key={d} role="radio" aria-checked={room.duration === d} className={room.duration === d ? "on" : ""} disabled={!host} onClick={() => onDuration(d)}>
            {d < 60 ? `${d}s` : `${d / 60} min`}
          </button>
        ))}
      </div>
      <div className="lh"><span>Players {connected.length} / 8</span><span>{host ? "You start the match" : "Host starts"} · never rated</span></div>
      <ul className="list">
        {room.players.map((p) => (
          <li key={p.key}>
            <span><b>{p.name}</b> <small>{[p.key === room.hostKey && "host", p.key === room.you && "you"].filter(Boolean).join(" · ")}</small></span>
            <small>{p.connected ? "Ready" : "Reconnecting…"}</small>
          </li>
        ))}
      </ul>
      <div style={{ marginTop: "1.5rem" }}>
        {host ? (
          <button className="btn primary" onClick={onStart} disabled={connected.length < 2}>{connected.length < 2 ? "Waiting for players" : "Start match"}</button>
        ) : (
          <p className="mute">Waiting for the host to start.</p>
        )}
      </div>
      {status === "closed" && <p className="error">Connection lost. <button className="link" onClick={onRetry}>Reconnect</button></p>}
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}

function Results({ results, me, room, ticks, questions, onRematch }: {
  results: MatchResults; me?: string; room: RoomSnapshot; ticks: Record<string, number[]>; questions: Map<number, Question>; onRematch: () => void;
}) {
  const s = useSession();
  const mine = results.rows.find((r) => r.key === me);
  const rivals = results.rows.filter((r) => r.key !== me);
  const best = rivals[0];
  const score = mine && best ? ` ${mine.correct}–${best.correct}` : "";
  const headline = !mine ? "Match over" : mine.outcome === "win" ? `You won${score}` : mine.outcome === "draw" ? `Draw${score}` : `You lost${score}`;
  const reason = ({ time: "Time", resign: "Resigned", abandoned: "Opponent left" } as Record<string, string>)[results.endReason] ?? "Time";
  const len = results.duration < 60 ? `${results.duration}s` : `${results.duration / 60} min`;
  const botFill = results.mode !== "bot" && rivals.some((r) => r.kind === "bot");
  useEffect(() => {
    if (!mine) return;
    savePace(mine.correct, results.duration);
    addSessionRun({
      id: `m:${results.matchId}`, mode: results.mode, duration: results.duration, correct: mine.correct, wrong: mine.wrong,
      at: Date.now(), outcome: mine.outcome, ...(rivals.length === 1 && best ? { opponent: best.name } : {}),
    });
  }, [results.matchId]); // eslint-disable-line react-hooks/exhaustive-deps
  const delta = mine?.ratingAfter !== undefined && mine.ratingBefore !== undefined ? mine.ratingAfter - mine.ratingBefore : null;
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
  const split = (k: string | undefined) => (ticks[k ?? ""] ?? []).map((t, i, a) => t - (i ? a[i - 1]! : 0));
  const myT = split(me);
  const theirT = rivals.length === 1 ? split(best?.key) : [];
  const rows = Math.max(myT.length, theirT.length);
  const sec = (ms: number | undefined) => (ms === undefined ? "–" : `${(ms / 1000).toFixed(2)}s`);
  return (
    <main className="page center results">
      <h1 className="verdict">{headline}</h1>
      <p className="mute">
        {rivals.length === 1 && best ? `vs ${best.name} · ` : ""}{len} · {reason}
        {results.rated && delta !== null && mine?.ratingAfter !== undefined
          ? <> · Ranked <b style={{ color: "var(--ink)" }}>{delta >= 0 ? "+" : "−"}{Math.abs(delta).toFixed(0)}</b> → {Math.round(mine.ratingAfter)}</>
          : botFill ? " · Unrated (bot)" : " · Unrated"}
      </p>
      <div className="row" style={{ justifyContent: "center", margin: "1rem 0 1.5rem" }}>
        {results.mode === "private" && !host ? <p className="mute">Waiting for the host to start a rematch.</p> : (
          <button className="btn primary" onClick={again}>{results.mode === "private" ? "Rematch" : results.mode === "bot" ? "Play again" : botFill && results.mode === "ranked" ? "Keep searching" : "New opponent"}</button>
        )}
        {mine && (
          <ShareButton text={resultShareText({
            outcome: mine.outcome, correct: mine.correct, wrong: mine.wrong, durationSec: results.duration,
            opponent: rivals.length === 1 && best ? { name: best.name, correct: best.correct } : undefined,
            rated: results.rated && delta !== null && mine.ratingAfter !== undefined ? { delta, after: mine.ratingAfter } : undefined,
          })} />
        )}
        <Link to="/" className="btn">Home</Link>
      </div>
      {mine && <RunProgress id={`m:${results.matchId}`} />}
      {rivals.length > 1 && (
        <table>
          <thead><tr><th scope="col">#</th><th scope="col" className="l">Player</th><th scope="col">Score</th></tr></thead>
          <tbody>
            {results.rows.map((r) => (
              <tr key={r.key} className={r.key === me ? "me" : ""}><td>{r.placement}</td><td className="l">{r.name}</td><td>{r.correct}{r.eliminated ? " · resigned" : ""}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {rows > 0 && (
        <table aria-label="Per-question times">
          <thead><tr><th scope="col">#</th><th scope="col" className="l">Problem</th><th scope="col">You</th>{theirT.length > 0 && <th scope="col">{best?.name}</th>}</tr></thead>
          <tbody>
            {Array.from({ length: rows }, (_, i) => {
              const q = questions.get(i) ?? (results.seed ? questionAt(results.seed, i) : undefined);
              const a = myT[i], b = theirT[i];
              const faster = a !== undefined && (b === undefined || a <= b) ? "me" : "them";
              return (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td className="l">{q ? `${formatQuestion(q)} = ${answerOf(q)}` : "–"}</td>
                  <td className={theirT.length && faster !== "me" ? "slow" : ""}>{sec(a)}</td>
                  {theirT.length > 0 && <td className={faster !== "them" ? "slow" : ""}>{sec(b)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {mine && <p className="hint">{mine.correct} correct · {mine.wrong} wrong{mine.eliminated ? " · resigned" : ""}</p>}
    </main>
  );
}
