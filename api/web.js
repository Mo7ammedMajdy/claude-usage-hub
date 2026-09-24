import { redis, slug, viewer, plain, num, pct, id, text, when, bool, obj } from "./_lib.js";

// Readings from the claude.ai userscript. Each person's browser sends what the page itself
// already downloaded: the plan limits after every message, and the size of the open chat.
// These are the only direct observations of claude.ai usage, and each is tied to one message,
// which is what later lets the hub learn how much a claude.ai message costs per person.
const READINGS_MAX = 2000;   // per person
const CHATS_MAX = 80;        // per person, most recently active kept
const SPAN_MS = 8 * 864e5, SKEW_MS = 10 * 60e3;   // events are placed by time: a week back to minutes ahead

// Everything here is stored and drawn on the dashboard, so each field is cut to its shape.
const conv = (v) => ((typeof v === "string" || typeof v === "number") && String(v).replace(/[^\w-]/g, "").slice(0, 8)) || null;
const count = num(0, 1e9), model = id(60);
const limit = (x) => (plain(x) ? { pct: typeof x.pct === "number" ? pct(x.pct) : null, resets_at: when(x.resets_at) } : null);
/** A chat as stored and as /api/summary serves it: only these fields. */
export const cleanChat = obj({ conv, tokens: count, messages: count, in_project: bool, model, last: when, p5: pct, pw: pct });
const tryParse = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const who = viewer(req);
  if (!who) return res.status(401).json({ error: "bad key" });
  const body = plain(req.body) ? req.body : {};
  const person = who === "*" ? text(40)(body.person) : who;
  const P = slug(person);
  if (!P) return res.status(400).json({ error: "person required" });
  const events = Array.isArray(body.events) ? body.events.slice(0, 200) : [];
  const browser = text(40)(body.browser) || "browser";
  const now = Date.now();

  const readings = [], chats = {};
  for (const e of events) {
    if (!plain(e)) continue;
    const t = when(e.t), at = Date.parse(t);
    if (!(at > now - SPAN_MS && at < now + SKEW_MS)) continue;
    const c = conv(e.conv), m = model(e.model);
    const five = limit(e.limits?.five), week = limit(e.limits?.week);
    if (e.kind === "completion" && plain(e.limits)) {
      readings.push({ t, conv: c, model: m, reply: count(e.reply_tokens), ctx: count(e.ctx_tokens),
        p5: five?.pct ?? null, pw: week?.pct ?? null, r5: five?.resets_at ?? null, rw: week?.resets_at ?? null,
        browser, retry: !!e.retry, stopped: !!e.stopped });
    }
    if (c && (e.kind === "conversation" || e.kind === "completion")) {
      const ch = chats[c] || { conv: c };
      if (e.kind === "conversation") Object.assign(ch, { tokens: count(e.tokens), messages: count(e.messages), in_project: !!e.in_project });
      if (m) ch.model = m;
      if (e.kind === "completion" && plain(e.limits)) Object.assign(ch, { p5: five?.pct ?? null, pw: week?.pct ?? null });
      ch.last = t > (ch.last || "") ? t : ch.last;
      chats[c] = ch;
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
    // Stored ones are re-checked too: they may predate these checks.
    const stored = out[out.length - 1] || {};
    const merged = {};
    for (const v of Object.values(stored)) { const c = cleanChat(tryParse(v)); if (c?.conv) merged[c.conv] = c; }
    for (const [k, c] of Object.entries(chats)) merged[k] = { ...(merged[k] || {}), ...c };
    const keep = Object.values(merged).sort((a, b) => (b.last || "").localeCompare(a.last || "")).slice(0, CHATS_MAX);
    const drop = Object.keys(stored).filter((k) => !keep.some((c) => c.conv === k));
    const w = redis.pipeline().hset(`webchat:${P}`, Object.fromEntries(keep.map((c) => [c.conv, JSON.stringify(c)])));
    if (drop.length) w.hdel(`webchat:${P}`, ...drop);
    w.sadd("webpeople", person);
    await w.exec();
  }
  res.status(200).json({ ok: true, person, readings: readings.length, chats: Object.keys(chats).length });
}
