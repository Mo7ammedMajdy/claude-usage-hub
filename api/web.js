import { redis, slug, viewer } from "./_lib.js";

// Readings from the claude.ai userscript. Each person's browser sends what the page itself
// already downloaded: the plan limits after every message, and the size of the open chat.
// These are the only direct observations of claude.ai usage, and each is tied to one message,
// which is what later lets the hub learn how much a claude.ai message costs per person.
const READINGS_MAX = 2000;   // per person
const CHATS_MAX = 80;        // per person, most recently active kept

const short = (id) => String(id || "").slice(0, 8);
const pct = (x) => (x && typeof x.pct === "number" ? x.pct : null);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const who = viewer(req);
  if (!who) return res.status(401).json({ error: "bad key" });
  const person = who === "*" ? String(req.body?.person || "") : who;
  if (!person) return res.status(400).json({ error: "person required" });
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 200) : [];
  const browser = String(req.body?.browser || "browser").slice(0, 40);
  const P = slug(person);

  const readings = [], chats = {};
  for (const e of events) {
    const conv = short(e.conv);
    if (e.kind === "completion" && e.limits) {
      readings.push({ t: e.t, conv, model: e.model || null, reply: e.reply_tokens ?? null, ctx: e.ctx_tokens ?? null,
        p5: pct(e.limits.five), pw: pct(e.limits.week), r5: e.limits.five?.resets_at || null, rw: e.limits.week?.resets_at || null,
        browser, retry: !!e.retry, stopped: !!e.stopped });
    }
    if (e.kind === "conversation" || e.kind === "completion") {
      const c = chats[conv] || { conv };
      if (e.kind === "conversation") Object.assign(c, { tokens: e.tokens, messages: e.messages, in_project: !!e.in_project });
      if (e.model) c.model = e.model;
      if (e.kind === "completion" && e.limits) Object.assign(c, { p5: pct(e.limits.five), pw: pct(e.limits.week) });
      c.last = e.t > (c.last || "") ? e.t : c.last;
      chats[conv] = c;
    }
  }

  if (!readings.length && !Object.keys(chats).length) {
    return res.status(200).json({ ok: true, person, readings: 0, chats: 0 });   // Upstash rejects an empty pipeline
  }
  const p = redis.pipeline();
  if (readings.length) p.rpush(`web:${P}`, ...readings.map((r) => JSON.stringify(r))).ltrim(`web:${P}`, -READINGS_MAX, -1);
  if (Object.keys(chats).length) p.hgetall(`webchat:${P}`);
  const out = await p.exec();

  if (Object.keys(chats).length) {
    // Merge with what is stored, so a completion doesn't wipe the size a tree read recorded.
    const stored = out[out.length - 1] || {};
    const merged = {};
    for (const [k, v] of Object.entries(stored)) merged[k] = typeof v === "string" ? JSON.parse(v) : v;
    for (const [k, c] of Object.entries(chats)) merged[k] = { ...(merged[k] || {}), ...c };
    const keep = Object.values(merged).sort((a, b) => (b.last || "").localeCompare(a.last || "")).slice(0, CHATS_MAX);
    const drop = Object.keys(merged).filter((k) => !keep.some((c) => c.conv === k));
    const w = redis.pipeline().hset(`webchat:${P}`, Object.fromEntries(keep.map((c) => [c.conv, JSON.stringify(c)])));
    if (drop.length) w.hdel(`webchat:${P}`, ...drop);
    w.sadd("webpeople", person);
    await w.exec();
  }
  res.status(200).json({ ok: true, person, readings: readings.length, chats: Object.keys(chats).length });
}
