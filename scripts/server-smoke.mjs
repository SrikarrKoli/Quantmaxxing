// End-to-end protocol check against a running worker (default: local `wrangler dev`).
// Usage: node scripts/server-smoke.mjs [baseUrl]
const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const PROJECT = process.env.FIREBASE_PROJECT_ID ?? "quantmaxxing-94ac5";
const WS = BASE.replace(/^http/, "ws");
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } else console.log("ok -", m); };
const post = async (path, body, headers = {}) => {
  const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const solve = (q) => q.op === "+" ? q.a + q.b : q.op === "-" ? q.a - q.b : q.op === "×" ? q.a * q.b : q.a / q.b;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function guest(name) {
  const g = await post("/api/guest", { username: name });
  assert(g.status === 200, `guest ${name} created`);
  const t = await post("/api/ticket", {}, { "X-Guest-Token": g.body.token });
  return { token: g.body.token, key: g.body.key, ticket: t.body.ticket };
}
function connect(url) {
  const ws = new WebSocket(url);
  const msgs = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data); msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  };
  const wait = (pred, ms = 8000) => new Promise((res, rej) => {
    const hit = msgs.find(pred); if (hit) { msgs.splice(msgs.indexOf(hit), 1); return res(hit); }
    const w = { pred, res: (m) => { msgs.splice(msgs.indexOf(m), 1); clearTimeout(timer); res(m); } };
    const timer = setTimeout(() => rej(new Error("timeout waiting")), ms);
    waiters.push(w);
  });
  return new Promise((res, rej) => { ws.onopen = () => res({ ws, wait, send: (o) => ws.send(JSON.stringify(o)) }); ws.onerror = rej; });
}

// Bad input
assert((await post("/api/guest", { username: "a b" })).status === 400, "invalid username rejected");
assert((await post("/api/ticket", {})).status === 401, "ticket requires identity");

// 1) Private room: same sequence, no advance on wrong, wrong answers never knock anyone out.
const A = await guest("AliceTest"); const B = await guest("BobTest");
const ev = await post("/api/event", { name: "share", src: "smoke" });
assert(ev.status === 204, "anonymous share event is counted");
const badEv = await post("/api/event", { name: "drop_table" });
assert(badEv.status === 400, "unknown analytics events are rejected");
const room = await post("/api/rooms", { duration: 30 }, { "X-Guest-Token": A.token });
assert(room.status === 200 && /^[A-Z2-9]{6}$/.test(room.body.code), "private room created with code");
const ca = await connect(`${WS}/ws/room/code-${room.body.code}?ticket=${A.ticket}`);
const cb = await connect(`${WS}/ws/room/code-${room.body.code.toLowerCase()}?ticket=${B.ticket}`);
await ca.wait((m) => m.t === "room" && m.room.players.length === 2);
cb.send({ t: "start" });
const notHost = await cb.wait((m) => m.t === "room", 500).catch(() => null);
ca.send({ t: "start" });
const ma = await ca.wait((m) => m.t === "match");
const mb = await cb.wait((m) => m.t === "match");
assert(JSON.stringify(ma.questions) === JSON.stringify(mb.questions), "both players get identical questions");
assert(!("hearts" in ma.self), "no hearts in player state");
await sleep(ma.startAt - ma.serverNow + 50);
// A answers 3 correctly
let qa = [...ma.questions];
for (let i = 0; i < 3; i++) {
  ca.send({ t: "ans", i, v: solve(qa[i]) });
  const ack = await ca.wait((m) => m.t === "ack" && m.i === i);
  assert(ack.ok && ack.self.correct === i + 1, `A correct #${i + 1}`);
  qa.push((await ca.wait((m) => m.t === "q")).questions[0]);
}
// B: wrong answer keeps the same question
cb.send({ t: "ans", i: 0, v: -1 });
let ack = await cb.wait((m) => m.t === "ack");
assert(!ack.ok && ack.self.wrong === 1 && ack.self.index === 0, "wrong answer counts and keeps the question");
cb.send({ t: "ans", i: 0, v: -1 });
ack = await cb.wait((m) => m.t === "ack");
assert(ack.self.wrong === 1, "burst wrong answer inside cooldown is ignored");
await sleep(400);
cb.send({ t: "ans", i: 0, v: solve(mb.questions[0]) });
ack = await cb.wait((m) => m.t === "ack" && m.ok);
assert(ack.self.index === 1, "correct answer after mistake advances");
cb.send({ t: "ans", i: 0, v: solve(mb.questions[0]) });
ack = await cb.wait((m) => m.t === "ack");
assert(!ack.ok && ack.self.correct === 1 && ack.self.wrong === 1, "duplicate stale submission costs nothing");
for (let k = 0; k < 4; k++) {
  await sleep(400); cb.send({ t: "ans", i: 1, v: -1 });
  ack = await cb.wait((m) => m.t === "ack");
}
assert(ack.self.wrong === 5 && !ack.self.eliminated && ack.self.index === 1, "five wrong answers don't knock a player out");
assert(!(await ca.wait((m) => m.t === "results", 600).catch(() => null)), "match keeps running after many wrong answers");
cb.send({ t: "resign" });
const res = await ca.wait((m) => m.t === "results");
assert(res.results.endReason === "resign" && !res.results.rows.some((r) => "hearts" in r), "match ends on resign, results have no hearts");
assert(res.results.rows[0].key === A.key && res.results.rows[0].outcome === "win", "remaining player wins");
assert(res.results.rated === false, "private rooms are unrated");
// rematch in the same room without a new code
ca.send({ t: "start" });
const rematch = await cb.wait((m) => m.t === "match");
assert(rematch.matchId !== ma.matchId, "host can rematch without re-entering the code");
ca.send({ t: "resign" });
const res2 = await cb.wait((m) => m.t === "results" && m.results.matchId === rematch.matchId);
assert(res2.results.endReason === "resign" && res2.results.rows[0].key === B.key, "resign ends the match");
ca.ws.close(); cb.ws.close();

// 2) Bot match
const bot = await post("/api/bot", { duration: 30, level: "expert" }, { "X-Guest-Token": A.token });
assert(bot.status === 200, "bot match created");
const A2 = await post("/api/ticket", {}, { "X-Guest-Token": A.token });
const cbot = await connect(`${WS}/ws/room/${bot.body.roomId}?ticket=${A2.body.ticket}`);
const mbot = await cbot.wait((m) => m.t === "match");
assert(mbot.progress.some((p) => p.key === "bot"), "bot participates");
await sleep(mbot.startAt - mbot.serverNow + 2500);
const prog = await cbot.wait((m) => m.t === "progress" && m.p.key === "bot");
assert(prog.p.correct >= 1, "bot makes progress over time");
cbot.ws.close();

// 3) Casual queue pairs two guests; ranked rejects guests
const C = await guest("CarolTest"); const D = await guest("DaveTest");
const qc = await connect(`${WS}/ws/lobby?queue=casual&duration=30&ticket=${C.ticket}`);
const qd = await connect(`${WS}/ws/lobby?queue=casual&duration=30&ticket=${D.ticket}`);
const mc = await qc.wait((m) => m.t === "matched"); const md = await qd.wait((m) => m.t === "matched");
assert(mc.roomId === md.roomId && mc.mode === "casual", "casual queue pairs guests");
const refused = await new Promise((res) => {
  const ws = new WebSocket(`${WS}/ws/lobby?queue=ranked&ticket=${C.ticket}`);
  ws.onopen = () => { ws.close(); res(false); };
  ws.onerror = () => res(true);
});
assert(refused, "ranked queue refuses guests");

// 4) Ranked with emulator-style Firebase tokens: profile, pairing, rated result, leaderboard.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (sub) => `${b64({ alg: "none", typ: "JWT" })}.${b64({ aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub, email: `${sub}@example.com`, email_verified: true, firebase: { sign_in_provider: "password" }, exp: Math.floor(Date.now() / 1000) + 3600 })}.`;
const suffix = Date.now().toString(36).slice(-5);
async function user(sub, name) {
  const auth = { Authorization: `Bearer ${idToken(sub)}` };
  const r = await fetch(`${BASE}/api/me`, { method: "PUT", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify({ username: name }) });
  assert(r.status === 200, `account ${name} created`);
  const t = await post("/api/ticket", {}, auth);
  return { auth, key: t.body.key, ticket: t.body.ticket };
}
const U1 = await user(`u1${suffix}`, `rk1${suffix}`); const U2 = await user(`u2${suffix}`, `rk2${suffix}`);
const taken = await fetch(`${BASE}/api/me`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken(`u3${suffix}`)}` }, body: JSON.stringify({ username: `rk1${suffix}` }) });
assert(taken.status === 409, "duplicate username rejected");
const l1 = await connect(`${WS}/ws/lobby?queue=ranked&ticket=${U1.ticket}`);
const l2 = await connect(`${WS}/ws/lobby?queue=ranked&ticket=${U2.ticket}`);
const r1 = await l1.wait((m) => m.t === "matched"); await l2.wait((m) => m.t === "matched");
assert(r1.mode === "ranked", "ranked queue pairs signed-in players");
const t1 = await post("/api/ticket", {}, U1.auth); const t2 = await post("/api/ticket", {}, U2.auth);
const g1 = await connect(`${WS}/ws/room/${r1.roomId}?ticket=${t1.body.ticket}`);
const g2 = await connect(`${WS}/ws/room/${r1.roomId}?ticket=${t2.body.ticket}`);
const rm = await g1.wait((m) => m.t === "match"); await g2.wait((m) => m.t === "match");
assert(rm.duration === 60, "ranked uses 60 seconds");
await sleep(rm.startAt - rm.serverNow + 50);
g1.send({ t: "ans", i: 0, v: solve(rm.questions[0]) }); await g1.wait((m) => m.t === "ack");
g2.send({ t: "resign" });
const rres = await g1.wait((m) => m.t === "results");
assert(rres.results.rated === true && rres.results.rows[0].key === U1.key, "ranked result is rated");
await sleep(500);
const me1 = await (await fetch(`${BASE}/api/me`, { headers: U1.auth })).json();
const me2 = await (await fetch(`${BASE}/api/me`, { headers: U2.auth })).json();
assert(me1.profile.rating === 1220 && me2.profile.rating === 1180, `elo applied (${me1.profile.rating} / ${me2.profile.rating})`);
assert(me1.profile.wins === 1 && me2.profile.losses === 1, "win/loss recorded");
const lb = await (await fetch(`${BASE}/api/leaderboard`)).json();
assert(lb.players.some((p) => p.username === `rk1${suffix}`), "leaderboard lists rated players");
// Bot fill: a lone queued player gets a labeled bot, and ranked bot games are unrated.
const botName = await fetch(`${BASE}/api/me`, { method: "PUT", headers: { "Content-Type": "application/json", ...U2.auth }, body: JSON.stringify({ username: "Medium_Bot" }) });
assert(botName.status >= 400 && botName.status < 500, "bot names are reserved");
const lone = await guest("Lonely");
const lq = await connect(`${WS}/ws/lobby?queue=casual&duration=30&ticket=${lone.ticket}&pace=30`);
const lqd = await lq.wait((m) => m.t === "queued");
assert(lqd.botInMs > 0, `queue announces bot fill (${lqd.botInMs}ms)`);
const lm = await lq.wait((m) => m.t === "matched", 20000);
assert(lm.bot === true && lm.mode === "casual", "lone casual player is matched with a bot");
const lr = await connect(`${WS}/ws/room/${lm.roomId}?ticket=${(await post("/api/ticket", {}, { "X-Guest-Token": lone.token })).body.ticket}`);
const lmatch = await lr.wait((m) => m.t === "match");
assert(lmatch.progress.some((p) => p.key === "bot") && lmatch.duration === 30, "bot-filled match has the bot and the queued duration");
lr.send({ t: "resign" });
const lres = await lr.wait((m) => m.t === "results");
assert(lres.results.mode === "casual" && lres.results.rows.some((r) => r.kind === "bot"), "bot-filled casual results list the bot");
const rq = await connect(`${WS}/ws/lobby?queue=ranked&ticket=${(await post("/api/ticket", {}, U1.auth)).body.ticket}`);
const rqm = await rq.wait((m) => m.t === "matched", 25000);
assert(rqm.bot === true && rqm.mode === "ranked", "lone ranked player is matched with a bot");
const rr = await connect(`${WS}/ws/room/${rqm.roomId}?ticket=${(await post("/api/ticket", {}, U1.auth)).body.ticket}`);
await rr.wait((m) => m.t === "match");
rr.send({ t: "resign" });
const rrres = await rr.wait((m) => m.t === "results");
assert(rrres.results.rated === false, "ranked bot match is unrated");
await sleep(500);
const me1b = await (await fetch(`${BASE}/api/me`, { headers: U1.auth })).json();
assert(me1b.profile.rating === 1220, `ranked bot match leaves rating alone (${me1b.profile.rating})`);
// Run history: signed-in solo runs and matches are saved; guests' matches can be claimed at sign-in.
assert((await fetch(`${BASE}/api/me/runs`)).status === 401, "run history needs sign-in");
assert((await post("/api/runs", { duration: 60, correct: 20, wrong: 1 })).status === 401, "saving a run needs sign-in");
assert((await post("/api/runs", { duration: 45, correct: 20, wrong: 1 }, U1.auth)).status === 400, "bad run length rejected");
assert((await post("/api/runs", { duration: 60, correct: 9999, wrong: 0 }, U1.auth)).status === 400, "impossible score rejected");
assert((await post("/api/runs", { duration: 60, correct: 21, wrong: 2 }, U1.auth)).status === 204, "solo run saved");
const runs1 = (await (await fetch(`${BASE}/api/me/runs`, { headers: U1.auth })).json()).runs;
assert(runs1.some((r) => r.mode === "practice" && r.correct === 21) && runs1.some((r) => r.mode === "ranked" && r.outcome === "win"), "history lists solo runs and matches");
const runs2 = (await (await fetch(`${BASE}/api/me/runs`, { headers: U2.auth })).json()).runs;
assert(!runs2.some((r) => r.mode === "practice"), "another player's runs stay private");
const U4 = await user(`u4${suffix}`, `rk4${suffix}`);
const claim = await post("/api/me/claim", { practice: [{ duration: 30, correct: 11, wrong: 0, at: Date.now() - 60_000 }, { duration: 7, correct: 1, wrong: 0 }] }, { ...U4.auth, "X-Guest-Token": lone.token });
assert(claim.status === 200 && claim.body.practice === 1 && claim.body.matches >= 1, `guest runs claimed at sign-in (${JSON.stringify(claim.body)})`);
const again = await post("/api/me/claim", { practice: [] }, { ...U1.auth, "X-Guest-Token": lone.token });
assert(again.body.matches === 0, "guest matches can only be claimed once");
const runs4 = (await (await fetch(`${BASE}/api/me/runs`, { headers: U4.auth })).json()).runs;
assert(runs4.some((r) => r.mode === "casual" && r.opponent) && runs4.some((r) => r.mode === "practice" && r.correct === 11), "claimed runs appear in history");
const hs = await fetch(`${BASE}/api/stats/mistakes`);
assert(hs.status === 200, "mistake telemetry endpoint responds");
console.log(JSON.stringify(await hs.json()).slice(0, 300));
console.log("\nALL SMOKE CHECKS PASSED");
process.exit(0);
