import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  DURATIONS, WRONG_COOLDOWN_MS, answerOf, formatQuestion, isDuration, questionAt, resultShareText,
  type DurationSec,
} from "@qm/shared";
import { Link, navigate } from "../router";
import { ShareButton } from "../ShareButton";
import { track } from "../track";
import { addSessionRun } from "../runs";
import { RunProgress } from "./Runs";
import { useSession } from "../session";

const len = (d: number) => (d < 60 ? `${d}s` : `${d / 60} min`);

/** Solo practice runs entirely in the browser, so it keeps working when the game server is busy or offline. */
export function Practice() {
  const q = Number(new URLSearchParams(window.location.search).get("d"));
  const [duration, setDuration] = useState<DurationSec>(isDuration(q) ? q : 60);
  const [seed, setSeed] = useState(() => crypto.randomUUID());
  const [phase, setPhase] = useState<"ready" | "play" | "done">("ready");
  const [endAt, setEndAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [index, setIndex] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [wrong, setWrong] = useState(0);
  const [value, setValue] = useState("");
  const [miss, setMiss] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const lastWrong = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const s = useSession();

  useEffect(() => {
    if (phase !== "play") return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => { if (phase === "play") input.current?.focus(); }, [phase, shake]);

  useEffect(() => {
    if (phase === "play" && now >= endAt) finish();
  }, [phase, now, endAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = () => {
    setPhase("done");
    track("practice_finish");
    const run = { id: `p:${seed}`, mode: "practice" as const, duration, correct, wrong, at: Date.now() };
    void s.authHeaders().then((auth) => addSessionRun(run, auth), () => addSessionRun(run));
  };

  const start = () => {
    setSeed(crypto.randomUUID());
    setIndex(0); setCorrect(0); setWrong(0); setValue(""); setMiss(null);
    const t = Date.now();
    setNow(t); setEndAt(t + duration * 1000); setPhase("play");
    track("practice_start");
  };

  const current = questionAt(seed, index);
  const onChange = (raw: string) => {
    const v = raw.replace(/[^0-9]/g, "").slice(0, 7);
    setValue(v);
    if (phase === "play" && v !== "" && Number(v) === answerOf(current)) {
      setCorrect((c) => c + 1); setIndex((i) => i + 1); setValue(""); setMiss(null);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || phase !== "play" || value === "") return;
    if (Date.now() - lastWrong.current < WRONG_COOLDOWN_MS) return;
    lastWrong.current = Date.now();
    setWrong((w) => w + 1); setMiss(value); setValue(""); setShake((n) => n + 1);
  };

  if (phase === "ready") {
    return (
      <main className="page center home">
        <h1>Solo practice</h1>
        <p className="sub">Same rules, no opponent. Runs in your browser and works offline. {s.profile ? "Every run is saved to your account." : "Your runs are kept for this visit; sign in to keep them for good."}</p>
        <div className="seg" role="radiogroup" aria-label="Match length">
          {DURATIONS.map((d) => (
            <button key={d} role="radio" aria-checked={duration === d} className={duration === d ? "on" : ""} onClick={() => setDuration(d)}>{len(d)}</button>
          ))}
        </div>
        <div className="acts"><button className="btn primary" onClick={start}>Start</button><Link to="/" className="btn">Home</Link></div>
      </main>
    );
  }

  if (phase === "done") {
    return (
      <main className="page center results">
        <h1 className="verdict">{correct} correct</h1>
        <p className="mute">Solo practice · {len(duration)} · {wrong} wrong</p>
        <RunProgress id={`p:${seed}`} />
        <div className="row" style={{ justifyContent: "center", margin: "1rem 0 1.5rem" }}>
          <button className="btn primary" onClick={start}>Play again</button>
          <ShareButton text={resultShareText({ outcome: "practice", correct, wrong, durationSec: duration })} />
          <button className="btn" onClick={() => navigate("/")}>Find an opponent</button>
        </div>
      </main>
    );
  }

  return (
    <main className="page match">
      <div className="hud">
        <div>
          <span>Time: {Math.max(0, Math.ceil((endAt - now) / 1000))}</span>
        </div>
        <div className="vs">Score: <b>{correct}</b></div>
      </div>
      <div className="stage">
        <p className="q" aria-live="polite">{formatQuestion(current)}</p>
        <label className="sr" htmlFor="answer">Answer</label>
        <input
          id="answer" ref={input} key={shake} className={`answer${shake ? " wrong" : ""}`}
          value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey}
          inputMode="numeric" autoComplete="off" autoCorrect="off" spellCheck={false}
        />
        <p className="miss" aria-live="polite">{miss ? <><s>{miss}</s>Wrong.</> : null}</p>
      </div>
      <button className="btn ghost resign" onClick={finish}>End</button>
    </main>
  );
}
