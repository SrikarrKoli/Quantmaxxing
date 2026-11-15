# Quantmaxxing

Head-to-head mental math. Everyone gets the same questions on the same clock; most correct answers wins.

- **Clock:** 30 seconds, 1 minute or 2 minutes (ranked is always 1 minute).
- **Hearts:** a wrong answer keeps you on the question and costs a heart. The third wrong answer knocks you out.
- **Modes:** bot practice, quick match, private rooms of up to 8 and ranked. Guests can play everything except ranked.
- **Accounts:** email and password or Google. Ranked uses Elo starting at 1200.

## How it works

| Part | Runs on | Does |
| --- | --- | --- |
| `packages/web` | Firebase Hosting (free Spark plan) | React + Vite client, Firebase Auth sign-in |
| `packages/server` | Cloudflare Workers free plan | HTTP API, WebSockets, Durable Objects for rooms and matchmaking, D1 for profiles and match history |
| `packages/shared` | both | Question generator, rules, ratings, bots and the wire protocol |

The server is authoritative: it generates the question sequence from a per-match seed, checks every answer, keeps the clock and decides the result. Clients see a few questions ahead so input feels instant.

## Local development

Requires Node 22 or newer.

```sh
npm install
cp packages/server/.dev.vars.example packages/server/.dev.vars   # set TOKEN_SECRET (openssl rand -hex 32)
(cd packages/server && npx wrangler d1 migrations apply quantmaxxing --local)
npm run dev:server   # http://127.0.0.1:8787
npm run dev:web      # http://127.0.0.1:5173, proxies /api and /ws to the server
```

Without Firebase config in `packages/web/.env`, guest play works and the sign-in pages say accounts aren't set up.

Checks:

```sh
npm run typecheck
npm test
npm run e2e:server   # plays full matches against a running local server
```

## Deploying

1. **Cloudflare:** `npx wrangler d1 create quantmaxxing`, put the returned ID in `packages/server/wrangler.toml`, then
   `npx wrangler d1 migrations apply quantmaxxing --remote`, `npx wrangler secret put TOKEN_SECRET` and `npx wrangler deploy` from `packages/server`.
2. **Firebase:** project `quantmaxxing-94ac5` (Email/Password and Google enabled) serves the `quantmaxxing` Hosting site. Its public web config is in `packages/web/.env.production`; set `VITE_API_ORIGIN` there to the Worker URL.
3. `npm run build && npx firebase deploy --only hosting:app`.

## Free-tier limits

Everything runs on free plans. The tightest limit is Cloudflare's 100,000 Worker requests per day (WebSocket messages after the upgrade are billed far more cheaply against Durable Object limits). A one-minute match costs a handful of requests per player, so that's thousands of matches a day. When a daily limit is hit, new requests fail until the reset at 00:00 UTC; the site shows "Can't reach the game server" rather than breaking silently.

## License

MIT
