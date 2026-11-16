import { useEffect, useState } from "react";
import { summarizeRuns, withChanges, type LengthSummary, type RunMode, type RunRecord } from "@qm/shared";
import { api } from "../api";
import { Link } from "../router";
import { useSessionRuns } from "../runs";
import { errorText, useSession } from "../session";

const MODE: Record<RunMode, string> = { practice: "Solo", bot: "Bot", casual: "Quick match", ranked: "Ranked", private: "Private room" };
const len = (d: number) => (d < 60 ? `${d}s` : `${d / 60} min`);
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "±0");
const when = (at: number) => {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
};

/** One line after a match or solo run: where it sits among this session's runs of the same length. */
export function RunProgress({ id }: { id: string }) {
  const runs = withChanges(useSessionRuns());
  const run = runs.find((r) => r.id === id);
  if (!run) return null;
  const same = runs.filter((r) => r.duration === run.duration);
  const n = same.findIndex((r) => r.id === id) + 1;
  const best = Math.max(...same.slice(0, n).map((r) => r.correct));
  return (
    <p className="hint">
      Run {n} at {len(run.duration)} this session
      {run.change !== null && <> · <b className="ink">{signed(run.change)}</b> vs last run</>}
      {run.best ? " · new best" : n > 1 ? ` · best ${best}` : ""}
      {" · "}<Link to="/runs">Your runs</Link>
    </p>
  );
}

function Spark({ runs, duration }: { runs: RunRecord[]; duration: number }) {
  const pts = runs.filter((r) => r.duration === duration).sort((a, b) => a.at - b.at).slice(-50);
  if (pts.length < 2) return null;
  const hi = Math.max(...pts.map((r) => r.correct), 1);
  const x = (i: number) => 4 + (i / (pts.length - 1)) * 292;
  const y = (c: number) => 56 - (c / hi) * 52;
  return (
    <figure className="spark">
      <svg viewBox="0 0 300 60" preserveAspectRatio="none" role="img"
        aria-label={`Correct answers per ${len(duration)} run, oldest to newest: ${pts.map((r) => r.correct).join(", ")}`}>
        <line x1="0" y1="56" x2="300" y2="56" />
        <polyline points={pts.map((r, i) => `${x(i)},${y(r.correct)}`).join(" ")} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="hint"><span>{len(duration)} runs, oldest to newest</span><span>best {hi}</span></figcaption>
    </figure>
  );
}

export function Runs() {
  const s = useSession();
  const sessionRuns = useSessionRuns();
  const signedIn = !!(s.user && s.profile);
  const [tab, setTab] = useState<"all" | "session">(signedIn ? "all" : "session");
  const [all, setAll] = useState<RunRecord[] | null>(null);
  const [allSummary, setAllSummary] = useState<LengthSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setTab(signedIn ? "all" : "session"); }, [signedIn]);
  useEffect(() => {
    if (!signedIn || tab !== "all") return;
    let live = true;
    (async () => {
      try {
        const auth = await s.authHeaders();
        const r = await api<{ runs: RunRecord[]; summary: LengthSummary[] }>("/api/me/runs", { auth: auth ?? {} });
        if (live) { setAll(r.runs); setAllSummary(r.summary); }
      } catch (e) { if (live) setError(errorText(e)); }
    })();
    return () => { live = false; };
  }, [signedIn, tab, sessionRuns.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = tab === "all" ? all : sessionRuns;
  const summary = tab === "all" ? (all ? allSummary : []) : summarizeRuns(sessionRuns);
  const rows = shown ? withChanges(shown).reverse() : [];
  const total = rows.length;

  return (
    <main className="page">
      <h1>Your runs</h1>
      {signedIn ? (
        <div className="seg" role="radiogroup" aria-label="Which runs">
          <button role="radio" aria-checked={tab === "all"} className={tab === "all" ? "on" : ""} onClick={() => setTab("all")}>All time</button>
          <button role="radio" aria-checked={tab === "session"} className={tab === "session" ? "on" : ""} onClick={() => setTab("session")}>This session</button>
        </div>
      ) : (
        <p className="hint">
          Runs from this visit, cleared when you close the tab. <Link to="/signup?next=/runs">Create an account</Link> or{" "}
          <Link to="/signin?next=/runs">sign in</Link> to keep every run. This visit's runs come with you.
        </p>
      )}
      {error && tab === "all" && <p className="error" role="alert">{error}</p>}
      {!shown && !error && <p aria-busy="true">Loading…</p>}
      {shown && total === 0 && <p>No runs yet. <Link to="/">Play a match</Link> or try <Link to="/practice">solo practice</Link>.</p>}
      {summary.length > 0 && (
        <>
          <ul className="list">
            {summary.map((g) => (
              <li key={g.duration}>
                <span><b>{len(g.duration)}</b> <small>{g.runs} {g.runs === 1 ? "run" : "runs"}</small></span>
                <span>
                  {g.runs > 1 ? <>first {g.first} → latest <b>{g.latest}</b> ({signed(g.latest - g.first)}) · </> : null}
                  best {g.best} · avg {g.average}
                </span>
              </li>
            ))}
          </ul>
          <Spark runs={shown!} duration={summary[0]!.duration} />
        </>
      )}
      {total > 0 && (
        <table>
          <thead><tr><th scope="col">#</th><th scope="col" className="l">When</th><th scope="col" className="l">Mode</th><th scope="col">Length</th><th scope="col">Correct</th><th scope="col">Wrong</th><th scope="col">Change</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id}>
                <td>{total - i}</td>
                <td className="l">{when(r.at)}</td>
                <td className="l">{MODE[r.mode]}{r.opponent ? ` vs ${r.opponent}` : ""}{r.outcome ? ` · ${r.outcome}` : ""}</td>
                <td>{len(r.duration)}</td>
                <td>{r.correct}</td>
                <td>{r.wrong}</td>
                <td>{r.change === null ? "–" : <>{signed(r.change)}{r.best ? " best" : ""}</>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
