// Prints launch metrics from the production database. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
// Usage: npm run stats            (add --local to read the local dev database)
import { execFileSync } from "node:child_process";

const where = process.argv.includes("--local") ? "--local" : "--remote";
const DAYS = 14;

function q(title, sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "quantmaxxing", where, "--json", "--command", sql], {
    cwd: new URL("../packages/server/", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  });
  console.log(`\n${title}`);
  console.table(JSON.parse(out)[0]?.results ?? []);
}

q(`Visitors per day (each browser counted once a day), last ${DAYS} days`, `
  SELECT day,
    SUM(CASE WHEN name = 'visit_new' THEN n ELSE 0 END) AS new_visitors,
    SUM(CASE WHEN name = 'visit_return' THEN n ELSE 0 END) AS returning_visitors,
    SUM(CASE WHEN name = 'share' THEN n ELSE 0 END) AS shares,
    SUM(CASE WHEN name = 'invite_copy' THEN n ELSE 0 END) AS invites,
    SUM(CASE WHEN name = 'practice_start' THEN n ELSE 0 END) AS practice
  FROM daily_events WHERE day >= date('now', '-${DAYS} days') GROUP BY day ORDER BY day DESC`);

q(`Where new visitors came from, last ${DAYS} days`, `
  SELECT src, SUM(n) AS new_visitors FROM daily_events
  WHERE name = 'visit_new' AND day >= date('now', '-${DAYS} days') GROUP BY src ORDER BY new_visitors DESC LIMIT 15`);

q(`Matches per day, last ${DAYS} days`, `
  SELECT date(m.ended_at / 1000, 'unixepoch') AS day, m.mode, COUNT(*) AS matches,
    SUM(EXISTS (SELECT 1 FROM match_players b WHERE b.match_id = m.id AND b.kind = 'bot')) AS vs_bot
  FROM matches m WHERE m.ended_at >= (strftime('%s', 'now') - ${DAYS} * 86400) * 1000
  GROUP BY day, m.mode ORDER BY day DESC, m.mode`);

q("Retention: players whose first match was in the last 30 days", `
  WITH p AS (
    SELECT mp.player_key, MIN(m.ended_at) AS first_at, COUNT(*) AS games,
      COUNT(DISTINCT date(m.ended_at / 1000, 'unixepoch')) AS active_days
    FROM match_players mp JOIN matches m ON m.id = mp.match_id
    WHERE mp.kind != 'bot' GROUP BY mp.player_key)
  SELECT COUNT(*) AS players,
    ROUND(100.0 * SUM(games >= 2) / MAX(COUNT(*), 1), 1) AS played_2nd_match_pct,
    ROUND(100.0 * SUM(active_days >= 2) / MAX(COUNT(*), 1), 1) AS came_back_another_day_pct
  FROM p WHERE first_at >= (strftime('%s', 'now') - 30 * 86400) * 1000`);
