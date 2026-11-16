# Quantmaxxing

**Head-to-head mental math.** Two players get the same arithmetic questions on the same clock. Whoever answers the most correctly before time runs out wins.

**Play it:** https://quantmaxxing.web.app. It's free, and you don't need an account to start.

Created and maintained by **Srikar Koli** ([@SrikarrKoli](https://github.com/SrikarrKoli)).

---

## Contents

- [How a match works](#how-a-match-works)
- [Ways to play](#ways-to-play)
- [Accounts, ratings and levels](#accounts-ratings-and-levels)
- [Bots](#bots)
- [How it's built](#how-its-built)
- [Project layout](#project-layout)
- [Running it locally](#running-it-locally)
- [Tests and checks](#tests-and-checks)
- [Deploying](#deploying)
- [Configuration](#configuration)
- [Security](#security)
- [Analytics](#analytics)
- [Free-tier limits](#free-tier-limits)
- [Contributing](#contributing)
- [License](#license)

## How a match works

Quantmaxxing is inspired by [Zetamac](https://arithmetic.zetamac.com/), but it's played against other people.

| Rule | Detail |
| --- | --- |
| **Same questions** | Every player in a match gets the same sequence of problems: addition, subtraction, multiplication and division. |
| **Fixed clock** | Matches last 30 seconds, 1 minute or 2 minutes. Ranked matches are always 1 minute. |
| **Play at your own pace** | Players don't wait for each other. A correct answer moves you straight to the next problem. |
| **Most correct wins** | When the clock runs out, the player with the most correct answers wins. If that's tied, fewer wrong answers wins, then whoever reached their score first. |
| **No knockouts** | A wrong answer keeps you on the same problem and counts against you in a tie. There's a short pause after each wrong answer so spamming guesses doesn't pay. Everyone plays the full clock. |
| **Live race** | During the match you see both scores and a tally race: one tick per correct answer along the match clock. |
| **Results** | After the match there's a breakdown of every problem, showing who answered it and how long each player took. |

## Ways to play

| Mode | Who can play | What happens |
| --- | --- | --- |
| **Bot practice** | Everyone | Play a bot right away at the level you pick. |
| **Quick match** | Everyone | Get matched with someone at the same match length. If nobody else is around, a bot takes their place (see [Bots](#bots)). |
| **Private room** | Everyone | Create a room with a 6-character code and share it with up to 7 friends. |
| **Ranked** | Signed-in players | 1-minute matches against another signed-in player. These change your rating. |
| **Solo practice** | Everyone | Same rules with no opponent. Runs entirely in the browser, so it works offline and when the server is busy. |

Guests get a random suggested username, which they can reroll or replace with their own, and can play every mode except Ranked.

After any match, **Share result** copies a plain-text result (score, opponent, wrong answers and a link) or opens the phone's share sheet. Links to the site show a preview image (`packages/web/public/og.png`).

## Accounts, ratings and levels

- **Sign-in:** email and password, or Google, through Firebase Authentication. Login forms work with password managers, and you can reset your password by email.
- **Rating:** Ranked uses Elo starting at 1200. New players' ratings move faster for their first 20 rated games.
- **Leaderboard:** the top 100 ranked players by rating.
- **Profiles:** public pages with rating, win/loss record, best 1-minute score and recent matches. Email addresses are never shown.
- **Levels:** you level up from total correct answers across all games.
- **Run history:** the Runs page lists every match and solo run with your score, wrong answers and the change from your last run at that length, plus a chart of your progress. Guests see the runs from their current visit (kept in the tab's session storage). Signed-in players get every run saved to their account; when a guest signs in, that browser's guest matches and unsaved solo runs move to the account. Solo runs only appear in your own history, never on the leaderboard.
- **Deleting your account** removes your profile and anonymizes your past matches.

## Bots

New games don't have many players online at once, so the matchmaker uses bots to make sure nobody waits forever.

- **Real players come first.** Two people waiting in the queue are always paired with each other.
- **Fallback wait:** if you're alone, a bot joins after 8 seconds in Quick match or 15 seconds in Ranked.
- **Pick your opponent:** while you wait, you can start a match right away against any of the bots below. The queue also recommends one based on your rating or your last score.
- **Clearly labeled:** bots never pretend to be people. The match says you're playing a bot, and the bot's name says so too.
- **Ranked stays fair:** bot games in Ranked are unrated and don't affect your rating or the leaderboard.
- **No XP farming:** bot games don't count as wins or losses. You get full XP for your first 5 bot games each day, half for the next 5, and none after that.

| Bot | Correct answers per minute (average) |
| --- | --- |
| Easy Bot | about 12 |
| Medium Bot | about 20 |
| Hard Bot | about 35 |
| **Quant Trader** (Expert) | about 59 |

Bots start a little slower, speed up as they warm up, and make the occasional mistake.

## How it's built

```
  Browser (React)                     Cloudflare Workers
  quantmaxxing.web.app                quantmaxxing-api
 ┌──────────────────┐   HTTPS API   ┌──────────────────────────────┐
 │ Firebase Hosting │ ────────────▶ │ Worker: auth, tickets, API   │
 │ Firebase Auth    │   WebSocket   │ Durable Object: Lobby (queue)│
 │                  │ ◀───────────▶ │ Durable Object: Room (match) │
 └──────────────────┘               │ D1 (SQLite): players, games  │
                                    └──────────────────────────────┘
```

- **The server makes every decision.** It creates the questions from a per-match seed, checks every answer, keeps the clock and decides the result. The browser only shows a few questions ahead so typing feels instant, so you can't cheat by editing the page.
- **Each match is one Durable Object.** Everyone in a match connects by WebSocket to the same Room. The queue is a single Lobby object.
- **Signing in:** the browser signs in with Firebase and sends its ID token to the Worker, which verifies it against Google's public keys. Guests get a signed guest token instead. To join a lobby or room, the browser trades either one for a short-lived ticket, valid for 60 seconds.
- **Storage:** player profiles, match history and ratings live in Cloudflare D1.

### Tech stack

| Layer | Tools |
| --- | --- |
| Client | React 19, Vite, TypeScript, plain CSS (black and white, system fonts, respects reduced motion) |
| Auth | Firebase Authentication (email/password and Google) |
| Hosting | Firebase Hosting, free Spark plan |
| Server | Cloudflare Workers, Durable Objects with WebSocket hibernation, D1, `jose` for verifying tokens |
| Shared logic | TypeScript package used by both client and server |
| Tests | Vitest unit tests, plus a smoke test that plays real matches against a running server |
| CI | GitHub Actions: typecheck, unit tests, build and server smoke test on every PR |

## Project layout

```
packages/
  shared/   Rules, question generator, ratings, bots, username rules, wire protocol (+ unit tests)
  server/   Cloudflare Worker: HTTP API (src/index.ts), Lobby and Room Durable Objects,
            D1 queries (src/db.ts), token signing (src/auth.ts), SQL migrations
  web/      React client: screens/ (Home, Queue, Room, Practice, Runs, Auth, Account, Leaderboard),
            session and API helpers, styles.css
scripts/
  server-smoke.mjs   Plays full matches against a local server: guests, rooms, bots,
                     queues, ranked ratings, run history and bot fallback
.github/workflows/ci.yml
firebase.json        Hosting config and security headers
```

## Running it locally

Requires **Node 22.12 or newer**.

```sh
git clone https://github.com/SrikarrKoli/quantmaxxing.git
cd quantmaxxing
npm install

# Local server settings. Edit TOKEN_SECRET (generate one with: openssl rand -hex 32)
cp packages/server/.dev.vars.example packages/server/.dev.vars

# Create the local database tables
(cd packages/server && npx wrangler d1 migrations apply quantmaxxing --local)

npm run dev:server   # API and WebSockets on http://127.0.0.1:8787
npm run dev:web      # Site on http://127.0.0.1:5173 (sends /api and /ws to the server)
```

Open http://127.0.0.1:5173 and play as a guest. To try sign-in locally, copy `packages/web/.env.example` to `packages/web/.env` and fill in the Firebase values, or point it at the Firebase Auth emulator. Without that, the sign-in pages just say accounts aren't set up yet.

## Tests and checks

```sh
npm run typecheck    # TypeScript, all packages
npm test             # Unit tests: questions, rules, ratings, bots, run history, usernames
npm run build        # Production build of the site
npm run e2e:server   # Full-match smoke test (needs npm run dev:server running)
```

CI runs all four on every pull request.

## Deploying

Everything runs on free plans.

1. **Cloudflare (game server)**, from `packages/server`:
   ```sh
   npx wrangler d1 create quantmaxxing            # put the returned ID in wrangler.toml
   npx wrangler d1 migrations apply quantmaxxing --remote
   npx wrangler secret put TOKEN_SECRET           # a long random string, never committed
   npx wrangler deploy
   ```
2. **Firebase (site and sign-in):** the project `quantmaxxing-94ac5` has Email/Password and Google sign-in turned on and serves the `quantmaxxing` Hosting site. The public web config is in `packages/web/.env.production`, and `VITE_API_ORIGIN` there points at the Worker.
3. **Publish the site:**
   ```sh
   npm run build
   npx firebase deploy --only hosting:app
   ```

## Configuration

Server settings (`packages/server/wrangler.toml` and Worker secrets):

| Name | Purpose |
| --- | --- |
| `TOKEN_SECRET` | **Secret.** Signs guest tokens and room tickets. Set with `wrangler secret put`. |
| `FIREBASE_PROJECT_ID` | Firebase project whose ID tokens the server accepts. |
| `ALLOWED_ORIGINS` | Comma-separated sites allowed to call the API from a browser. |
| `BOT_FILL_CASUAL_MS` / `BOT_FILL_RANKED_MS` | How long a lone player waits before a bot joins (`8000` / `15000`). `0` turns bot fill off. |
| `AUTH_EMULATOR` | Local only. Accepts unsigned emulator tokens. Must be `false` in production. |
| `DISABLE_RATE_LIMITS` | Local and CI only. Must never be set in production. |

Site settings (`packages/web/.env*`): `VITE_API_ORIGIN` and the public Firebase web config. The Firebase web API key isn't a secret: it identifies the project, and access is controlled by Firebase Auth and its list of allowed domains.

## Security

- The server makes every scoring decision. Answers are checked against the server's own copy of the questions, and spam, duplicate and late answers are ignored.
- Firebase ID tokens are checked for signature (RS256), issuer and audience. Guest tokens and room tickets are HMAC-SHA-256 signed and expire.
- All database queries use bound parameters.
- The API only accepts browser requests from the allowed sites. Request bodies are size-limited, and rooms, guests, bots and joins are rate-limited.
- No secrets are committed. `.dev.vars` and `.env` files are gitignored.
- The site sends `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, a strict referrer policy and a restrictive permissions policy.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Analytics

The site keeps privacy-safe daily counters in D1 (`daily_events`): each browser is counted once per UTC day as new or returning, plus shares, invite-link copies and solo practice runs, grouped by traffic source (`?s=`, `?ref=` or `?utm_source=` on the link, else the referring site). No cookies, IP addresses, user agents or user IDs are stored. Match history (already stored for every game) supplies matches per day, bot-vs-human share and retention.

```sh
npm run stats          # production; needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
npm run stats -- --local
```

It prints visitors per day, top sources, matches per day by mode, and the share of new players who played a second match or came back another day. Tag links you post, for example `https://quantmaxxing.web.app/?s=reddit`.

## Free-tier limits

The tightest limit is Cloudflare's free quota of 100,000 Worker requests per day. WebSocket messages after connecting count toward the much larger Durable Object allowance instead. A match takes only a handful of requests per player, so that's thousands of matches a day. Analytics adds one request per browser per day plus one per share, invite copy or practice run.

To stretch the quota, the leaderboard is cached in the browser for 60 seconds. If the limit is hit anyway, the site says the server is busy or at its daily limit (it resets at 00:00 UTC) and points players to solo practice, which needs no server. Watch usage in the Cloudflare dashboard under Workers & Pages; if launch traffic gets close, the Workers Paid plan ($5/month) raises the limit to 10 million requests.

## Contributing

Issues and pull requests are welcome. Please run `npm run typecheck && npm test && npm run build` before opening a PR. The design is deliberately minimal: white background, black text, greys only, system fonts and thin divider lines. Please keep new screens in that style.

## License

[MIT](LICENSE) © 2026 Srikar Koli
