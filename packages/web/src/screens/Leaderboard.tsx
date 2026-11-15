import { useEffect, useState } from "react";
import { api } from "../api";
import { Link } from "../router";
import { errorText } from "../session";

interface Row { username: string; rating: number; rated_games: number; wins: number; losses: number; draws: number; best_60: number; level: number }
interface HistoryRow { id: string; mode: string; duration_s: number; ended_at: number; outcome: string; correct: number; wrong: number; rated: number; rating_before: number | null; rating_after: number | null }

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null); setError(null);
    api<T>(path).then((d) => live && setData(d)).catch((e) => live && setError(errorText(e)));
    return () => { live = false; };
  }, [path]);
  return { data, error };
}

export function Leaderboard() {
  const { data, error } = useLoad<{ players: Row[] }>("/api/leaderboard");
  return (
    <main className="page">
      <h1>Leaderboard</h1>
      <p className="hint">Ranked ratings. Play one ranked match to appear here.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {!data && !error && <p aria-busy="true">Loading…</p>}
      {data && data.players.length === 0 && <p>No ranked matches yet. <Link to="/queue/ranked">Be the first</Link>.</p>}
      {data && data.players.length > 0 && (
        <table>
          <thead><tr><th scope="col">#</th><th scope="col">Player</th><th scope="col">Rating</th><th scope="col">W–L–D</th><th scope="col">Best 1 min</th><th scope="col">Level</th></tr></thead>
          <tbody>
            {data.players.map((p, i) => (
              <tr key={p.username}><td>{i + 1}</td><td><Link to={`/u/${p.username}`}>{p.username}</Link></td><td>{Math.round(p.rating)}</td><td>{p.wins}–{p.losses}–{p.draws}</td><td>{p.best_60}</td><td>{p.level}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

export function PlayerPage({ username }: { username: string }) {
  const { data, error } = useLoad<{ profile: Row; history: HistoryRow[] }>(`/api/players/${username}`);
  if (error) return <main className="page narrow"><h1>{username}</h1><p className="error" role="alert">{error}</p></main>;
  if (!data) return <main className="page narrow" aria-busy="true"><p>Loading…</p></main>;
  const p = data.profile;
  return (
    <main className="page">
      <h1>{p.username}</h1>
      <dl className="stats">
        <div><dt>Rating</dt><dd>{Math.round(p.rating)}</dd></div>
        <div><dt>Level</dt><dd>{p.level}</dd></div>
        <div><dt>Record</dt><dd>{p.wins}–{p.losses}–{p.draws}</dd></div>
        <div><dt>Best 1 min</dt><dd>{p.best_60}</dd></div>
      </dl>
      <h2>Recent matches</h2>
      {data.history.length === 0 ? <p>No matches yet.</p> : (
        <table>
          <thead><tr><th scope="col">Date</th><th scope="col">Mode</th><th scope="col">Result</th><th scope="col">Correct</th><th scope="col">Wrong</th><th scope="col">Rating</th></tr></thead>
          <tbody>
            {data.history.map((h) => (
              <tr key={h.id}>
                <td>{new Date(h.ended_at).toLocaleDateString()}</td><td>{h.mode} · {h.duration_s}s</td><td>{h.outcome}</td><td>{h.correct}</td><td>{h.wrong}</td>
                <td>{h.rated && h.rating_after !== null && h.rating_before !== null ? `${Math.round(h.rating_after)} (${h.rating_after >= h.rating_before ? "+" : ""}${(h.rating_after - h.rating_before).toFixed(1)})` : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
