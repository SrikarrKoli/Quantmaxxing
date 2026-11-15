import { useEffect, useState, type FormEvent } from "react";
import {
  GoogleAuthProvider, browserLocalPersistence, browserSessionPersistence, createUserWithEmailAndPassword,
  sendPasswordResetEmail, setPersistence, signInWithEmailAndPassword, signInWithPopup,
} from "firebase/auth";
import { USERNAME_RULE, validateUsername } from "@qm/shared";
import { api } from "../api";
import { firebaseAuth } from "../firebase";
import { Link, navigate } from "../router";
import { errorText, useSession } from "../session";

const next = () => {
  const n = new URLSearchParams(window.location.search).get("next");
  return n && n.startsWith("/") && !n.startsWith("//") ? n : "/";
};

function firebaseMessage(e: unknown): string {
  const code = (e as { code?: string }).code ?? "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return "Email or password is incorrect.";
  if (code.includes("email-already-in-use")) return "An account with that email already exists. Sign in instead.";
  if (code.includes("weak-password")) return "Use at least 8 characters for your password.";
  if (code.includes("invalid-email")) return "Enter a valid email address.";
  if (code.includes("too-many-requests")) return "Too many attempts. Wait a minute and try again.";
  if (code.includes("popup-closed")) return "Google sign-in was closed before it finished.";
  if (code.includes("account-exists-with-different-credential")) return "That email already uses a different sign-in method.";
  if (code.includes("network")) return "Can't reach the sign-in service. Check your connection.";
  return "Sign-in failed. Try again.";
}

function Unavailable() {
  return (
    <main className="page narrow">
      <h1>Accounts are not set up yet</h1>
      <p>Sign-in isn't configured on this server. You can still <Link to="/">play as a guest</Link>.</p>
    </main>
  );
}

function GoogleButton({ remember }: { remember: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    const auth = firebaseAuth()!;
    try {
      await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
      await signInWithPopup(auth, new GoogleAuthProvider());
      navigate(next(), true);
    } catch (e) { setError(firebaseMessage(e)); }
  };
  return (
    <>
      <button type="button" className="btn wide" onClick={go}>Continue with Google</button>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

function EmailForm({ mode }: { mode: "signin" | "signup" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === "signup" && password.length < 8) { setError("Use at least 8 characters for your password."); return; }
    const auth = firebaseAuth()!;
    setBusy(true); setError(null);
    try {
      await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
      if (mode === "signin") await signInWithEmailAndPassword(auth, email.trim(), password);
      else await createUserWithEmailAndPassword(auth, email.trim(), password);
      navigate(next(), true);
    } catch (err) { setError(firebaseMessage(err)); } finally { setBusy(false); }
  };
  return (
    <>
      <GoogleButton remember={remember} />
      <p className="or"><span>or</span></p>
      <form onSubmit={submit} noValidate>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete={mode === "signin" ? "username" : "email"} value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required aria-describedby="pw-help" />
        <p id="pw-help" className="hint">{mode === "signup" ? "At least 8 characters." : <Link to="/reset">Forgot your password?</Link>}</p>
        <label className="check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Keep me signed in</label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary wide" type="submit" disabled={busy}>{mode === "signin" ? "Sign in" : "Create account"}</button>
      </form>
    </>
  );
}

export function SignIn() {
  const s = useSession();
  useEffect(() => { if (s.profile) navigate(next(), true); }, [s.profile]);
  if (!s.authAvailable) return <Unavailable />;
  return (
    <main className="page narrow">
      <h1>Sign in</h1>
      <p>Ranked play, ratings and match history need an account.</p>
      <EmailForm mode="signin" />
      <p>New here? <Link to={`/signup${window.location.search}`}>Create an account</Link></p>
    </main>
  );
}

export function SignUp() {
  const s = useSession();
  if (!s.authAvailable) return <Unavailable />;
  return (
    <main className="page narrow">
      <h1>Create an account</h1>
      <p>Guest games aren't carried over; your account starts fresh.</p>
      <EmailForm mode="signup" />
      <p>Already have one? <Link to={`/signin${window.location.search}`}>Sign in</Link></p>
    </main>
  );
}

export function ResetPassword() {
  const s = useSession();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!s.authAvailable) return <Unavailable />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try { await sendPasswordResetEmail(firebaseAuth()!, email.trim()); setSent(true); }
    catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (code.includes("user-not-found")) setSent(true);
      else setError(firebaseMessage(err));
    }
  };
  return (
    <main className="page narrow">
      <h1>Reset your password</h1>
      {sent ? (
        <p role="status">If an account uses {email}, a reset link is on its way. <Link to="/signin">Back to sign in</Link></p>
      ) : (
        <form onSubmit={submit}>
          <label htmlFor="remail">Email</label>
          <input id="remail" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn primary wide" type="submit">Send reset link</button>
        </form>
      )}
    </main>
  );
}

export function ChooseUsername() {
  const s = useSession();
  const [name, setName] = useState(s.profile?.username ?? s.guest?.username ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!name) api<{ username: string }>("/api/names/suggest").then((r) => setName(r.username)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = validateUsername(name);
    if (!v.ok) { setError(v.reason); return; }
    setBusy(true);
    try {
      const token = await s.user!.getIdToken();
      await api("/api/me", { method: "PUT", body: { username: v.name }, auth: { Authorization: `Bearer ${token}` } });
      await s.refreshProfile();
      navigate(next(), true);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  return (
    <main className="page narrow">
      <h1>{s.profile ? "Change username" : "Choose a username"}</h1>
      <p>This is how other players and the leaderboard will see you.</p>
      <form onSubmit={submit}>
        <label htmlFor="uname">Username</label>
        <div className="row">
          <input id="uname" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} maxLength={20} autoComplete="off" aria-describedby="uname-help" aria-invalid={!!error} />
          <button type="button" className="btn" onClick={() => api<{ username: string }>("/api/names/suggest").then((r) => setName(r.username)).catch(() => {})}>New name</button>
        </div>
        <p id="uname-help" className={error ? "error" : "hint"}>{error ?? USERNAME_RULE}</p>
        <button className="btn primary wide" type="submit" disabled={busy}>Save</button>
      </form>
      {!s.profile && <p><button className="link" onClick={() => s.signOut()}>Sign out</button></p>}
    </main>
  );
}
