import { useState } from "react";
import { api } from "../api";
import { Link, navigate } from "../router";
import { errorText, useSession } from "../session";

export function Account() {
  const s = useSession();
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!s.user || !s.profile) {
    return <main className="page narrow"><h1>Account</h1><p><Link to="/signin?next=/account">Sign in</Link> to manage your account.</p></main>;
  }
  const p = s.profile;
  const del = async () => {
    try {
      const token = await s.user!.getIdToken();
      await api("/api/me", { method: "DELETE", auth: { Authorization: `Bearer ${token}` } });
      await s.user!.delete().catch(() => s.signOut());
      navigate("/", true);
    } catch (e) { setError(errorText(e)); }
  };
  return (
    <main className="page narrow">
      <h1>{p.username}</h1>
      <p className="hint">{s.user.email}</p>
      <dl className="stats">
        <div><dt>Rating</dt><dd>{Math.round(p.rating)}</dd></div>
        <div><dt>Level</dt><dd>{p.level}</dd></div>
        <div><dt>Record</dt><dd>{p.wins}–{p.losses}–{p.draws}</dd></div>
      </dl>
      <p className="row">
        <Link to={`/u/${p.username}`} className="btn">Public profile</Link>
        <Link to="/account/username?next=/account" className="btn">Change username</Link>
        <button className="btn ghost" onClick={async () => { await s.signOut(); navigate("/", true); }}>Sign out</button>
      </p>
      <section className="panel danger">
        <h2>Delete account</h2>
        <p>Removes your profile and rating. Past matches stay in opponents' history without your name.</p>
        <label htmlFor="del">Type your username to confirm</label>
        <input id="del" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn danger" disabled={confirm !== p.username} onClick={del}>Delete account</button>
      </section>
    </main>
  );
}
