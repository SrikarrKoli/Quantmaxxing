import { initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";

const env = import.meta.env;
const config = {
  apiKey: env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: (env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined) ?? "quantmaxxing-94ac5.firebaseapp.com",
  projectId: (env.VITE_FIREBASE_PROJECT_ID as string | undefined) ?? "quantmaxxing-94ac5",
  appId: env.VITE_FIREBASE_APP_ID as string | undefined,
};
const emulator = env.VITE_AUTH_EMULATOR as string | undefined;

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

export function firebaseAuth(): Auth | null {
  if (auth) return auth;
  if (!config.apiKey && !emulator) return null;
  app = initializeApp({ ...config, apiKey: config.apiKey || "demo-key" });
  auth = getAuth(app);
  if (emulator) connectAuthEmulator(auth, emulator, { disableWarnings: true });
  return auth;
}
