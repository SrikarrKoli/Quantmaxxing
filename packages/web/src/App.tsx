import { Link, usePath } from "./router";
import { useSession } from "./session";
import { Home } from "./screens/Home";
import { RoomScreen } from "./screens/Room";
import { Queue } from "./screens/Queue";
import { SignIn, SignUp, ResetPassword, ChooseUsername } from "./screens/Auth";
import { Leaderboard, PlayerPage } from "./screens/Leaderboard";
import { Account } from "./screens/Account";
import { Practice } from "./screens/Practice";

function Screen({ path }: { path: string }) {
  const s = useSession();
  if (s.user && s.needsProfile && path !== "/account/username") return <ChooseUsername />;
  let m: RegExpMatchArray | null;
  if (path === "/") return <Home />;
  if (path === "/practice") return <Practice />;
  if ((m = path.match(/^\/r\/([A-Za-z0-9]{6})$/))) return <RoomScreen roomId={`code-${m[1]!.toUpperCase()}`} />;
  if ((m = path.match(/^\/m\/([A-Za-z0-9-]{6,64})$/))) return <RoomScreen roomId={m[1]!} />;
  if ((m = path.match(/^\/queue\/(casual|ranked)$/))) return <Queue kind={m[1] as "casual" | "ranked"} />;
  if (path === "/signin") return <SignIn />;
  if (path === "/signup") return <SignUp />;
  if (path === "/reset") return <ResetPassword />;
  if (path === "/account/username") return <ChooseUsername />;
  if (path === "/account") return <Account />;
  if (path === "/leaderboard") return <Leaderboard />;
  if ((m = path.match(/^\/u\/([A-Za-z0-9_-]{3,20})$/))) return <PlayerPage username={m[1]!} />;
  return (
    <main className="page narrow">
      <h1>Page not found</h1>
      <p><Link to="/">Back to the home screen</Link></p>
    </main>
  );
}

export function App() {
  const path = usePath();
  const s = useSession();
  const inMatch = path.startsWith("/m/") || path.startsWith("/r/");
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className={`bar${inMatch ? " slim" : ""}`}>
        <Link to="/" className="logo" aria-label="Quantmaxxing home"><span aria-hidden="true">Quantma<i>××</i>ing</span></Link>
        <nav aria-label="Main">
          <Link to="/leaderboard">Leaderboard</Link>
        </nav>
        <div className="who">
          {s.name && <span className="chip" title={s.profile ? "Signed in" : "Playing as a guest"}>{s.name}</span>}
          {s.user ? <Link to="/account">Account</Link> : <Link to="/signin">Sign in</Link>}
        </div>
      </header>
      <div id="main">{s.ready || path === "/practice" ? <Screen path={path} /> : <main className="page narrow" aria-busy="true"><p>Loading…</p></main>}</div>
    </>
  );
}
