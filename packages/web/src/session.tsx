import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { onIdTokenChanged, signOut as fbSignOut, type User } from "firebase/auth";
import { api, ApiError, type AuthHeaders } from "./api";
import { firebaseAuth } from "./firebase";

interface Guest { token: string; key: string; username: string }
export interface Profile {
  uid: string; username: string; rating: number; rated_games: number; wins: number; losses: number; draws: number;
  total_correct: number; best_60: number; level: number;
}

interface Session {
  ready: boolean;
  user: User | null;
  profile: Profile | null;
  needsProfile: boolean;
  guest: Guest | null;
  name: string | null;
  authHeaders: () => Promise<AuthHeaders | null>;
  startGuest: (username: string) => Promise<AuthHeaders>;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
  authAvailable: boolean;
}

const Ctx = createContext<Session | null>(null);
const GUEST_KEY = "qm.guest";

function loadGuest(): Guest | null {
  try {
    const g = JSON.parse(localStorage.getItem(GUEST_KEY) ?? "null") as Guest | null;
    return g?.token ? g : null;
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const auth = firebaseAuth();
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [needsProfile, setNeedsProfile] = useState(false);
  const [guest, setGuest] = useState<Guest | null>(loadGuest);
  const [ready, setReady] = useState(!auth);

  const loadProfile = useCallback(async (u: User | null) => {
    if (!u) { setProfile(null); setNeedsProfile(false); return; }
    try {
      const token = await u.getIdToken();
      const res = await api<{ profile: Profile | null }>("/api/me", { auth: { Authorization: `Bearer ${token}` } });
      setProfile(res.profile);
      setNeedsProfile(!res.profile);
    } catch {
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    if (!auth) return;
    return onIdTokenChanged(auth, async (u) => {
      setUser(u);
      await loadProfile(u);
      setReady(true);
    });
  }, [auth, loadProfile]);

  const authHeaders = useCallback(async (): Promise<AuthHeaders | null> => {
    if (user && profile) return { Authorization: `Bearer ${await user.getIdToken()}` };
    if (guest) return { "X-Guest-Token": guest.token };
    return null;
  }, [user, profile, guest]);

  const startGuest = useCallback(async (username: string) => {
    const g = await api<Guest>("/api/guest", { method: "POST", body: { username } });
    localStorage.setItem(GUEST_KEY, JSON.stringify(g));
    setGuest(g);
    return { "X-Guest-Token": g.token };
  }, []);

  const signOut = useCallback(async () => {
    if (auth) await fbSignOut(auth);
  }, [auth]);

  const value = useMemo<Session>(() => ({
    ready, user, profile, needsProfile, guest,
    name: profile?.username ?? guest?.username ?? null,
    authHeaders, startGuest, refreshProfile: () => loadProfile(user), signOut, authAvailable: !!auth,
  }), [ready, user, profile, needsProfile, guest, authHeaders, startGuest, loadProfile, signOut, auth]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("SessionProvider missing");
  return s;
}

export function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Try again.";
}
