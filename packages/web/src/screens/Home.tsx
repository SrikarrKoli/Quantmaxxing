import { useEffect, useState, type FormEvent } from "react";
import { BOT_LEVELS, DURATIONS, USERNAME_RULE, validateUsername, type BotLevel, type DurationSec } from "@qm/shared";
import { api, type AuthHeaders } from "../api";
import { Link, navigate } from "../router";
import { errorText, useSession } from "../session";

type Action = { kind: "bot"; level: BotLevel } | { kind: "casual" } | { kind: "room" } | { kind: "join"; code: string };

export function Home() {
  const s = useSession();
  const [duration, setDuration] = useState<DurationSec>(60);
  const [level, setLevel] = useState<BotLevel>("medium");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(a: Action, given?: AuthHeaders) {
    setError(null);
    const auth = given ?? (await s.authHeaders());
    if (!auth) { setPending(a); return; }
    setBusy(true);
    try {
      if (a.kind === "bot") {
        const r = await api<{ roomId: string }>("/api/bot", { method: "POST", body: { duration, level: a.level }, auth });
        navigate(`/m/${r.roomId}`);
      } else if (a.kind === "room") {
        const r = await api<{ code: string }>("/api/rooms", { method: "POST", body: { duration }, auth });
        navigate(`/r/${r.code}`);
      } else if (a.kind === "join") {
        navigate(`/r/${a.code}`);
      } else {
        navigate(`/queue/casual?d=${duration}`);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const onJoin = (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(c)) { setError("Room codes are 6 letters and numbers."); return; }
    void run({ kind: "join", code: c });
  };

  return (
    <main className="page home">
      <section className="intro">
        <h1>Same questions. Fixed clock. Most right answers wins.</h1>
        <p className="lede">Head-to-head mental math. Wrong answers keep you on the question, and the third one knocks you out.</p>
      </section>

      <section className="panel" aria-labelledby="len">
        <h2 id="len">Match length</h2>
        <div className="seg" role="radiogroup" aria-labelledby="len">
          {DURATIONS.map((d) => (
            <button key={d} role="radio" aria-checked={duration === d} className={duration === d ? "on" : ""} onClick={() => setDuration(d)}>
              {d < 60 ? `${d} s` : `${d / 60} min`}
            </button>
          ))}
        </div>
      </section>

      <section className="modes">
        <div className="panel">
          <h2>Quick match</h2>
          <p>Play the next person in the queue. Guests welcome, never rated.</p>
          <button className="btn primary" disabled={busy} onClick={() => run({ kind: "casual" })}>Find an opponent</button>
        </div>
        <div className="panel">
          <h2>Ranked</h2>
          <p>One-minute matches against players near your rating.</p>
          {s.profile ? (
            <button className="btn" onClick={() => navigate("/queue/ranked")}>Play ranked · {Math.round(s.profile.rating)}</button>
          ) : (
            <Link to="/signin?next=/queue/ranked" className="btn">Sign in to play ranked</Link>
          )}
        </div>
        <div className="panel">
          <h2>Play a bot</h2>
          <div className="seg small" role="radiogroup" aria-label="Bot level">
            {(Object.keys(BOT_LEVELS) as BotLevel[]).map((l) => (
              <button key={l} role="radio" aria-checked={level === l} className={level === l ? "on" : ""} onClick={() => setLevel(l)}>
                {BOT_LEVELS[l].label}
              </button>
            ))}
          </div>
          <button className="btn" disabled={busy} onClick={() => run({ kind: "bot", level })}>Start bot match</button>
        </div>
        <div className="panel">
          <h2>Private room</h2>
          <p>Up to 8 friends with a code. Rooms are never rated.</p>
          <button className="btn" disabled={busy} onClick={() => run({ kind: "room" })}>Create a room</button>
          <form className="row" onSubmit={onJoin}>
            <label className="sr" htmlFor="code">Room code</label>
            <input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Room code" maxLength={6} autoCapitalize="characters" autoComplete="off" spellCheck={false} />
            <button className="btn" type="submit">Join</button>
          </form>
        </div>
      </section>
      {error && <p className="error" role="alert">{error}</p>}
      {pending && <GuestNameDialog onDone={(auth) => { const a = pending; setPending(null); void run(a, auth); }} onCancel={() => setPending(null)} />}
    </main>
  );
}

export function GuestNameDialog({ onDone, onCancel }: { onDone: (auth: AuthHeaders) => void; onCancel: () => void }) {
  const s = useSession();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reroll = async () => {
    try { setName((await api<{ username: string }>("/api/names/suggest")).username); } catch (e) { setError(errorText(e)); }
  };
  useEffect(() => { void reroll(); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = validateUsername(name);
    if (!v.ok) { setError(v.reason); return; }
    setBusy(true);
    try { onDone(await s.startGuest(v.name)); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="gn">
      <form className="dialog" onSubmit={submit}>
        <h2 id="gn">Pick a name</h2>
        <p>Guests play every mode except ranked. Nothing is saved to an account.</p>
        <label htmlFor="gname">Username</label>
        <div className="row">
          <input id="gname" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} maxLength={20} autoComplete="off" autoFocus aria-describedby="gname-help" aria-invalid={!!error} />
          <button type="button" className="btn" onClick={reroll}>New name</button>
        </div>
        <p id="gname-help" className={error ? "error" : "hint"}>{error ?? USERNAME_RULE}</p>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !name}>Play as guest</button>
        </div>
        <p className="hint">Want ranked? <Link to="/signup">Create an account</Link> instead.</p>
      </form>
    </div>
  );
}
