import { viewer, redis, slug, family, plain, num, pct, id, text, when, day, bool, list, obj, map } from "./_lib.js";
import { fitDevices } from "./_fit.js";
import { freshestOfficial, split } from "./_split.js";
import { averageForecast, forecastWeek, weekHours } from "./_forecast.js";
import { unloggedPath } from "./_unlogged.js";
export { combine } from "./_combine.js";

// Calibration readings are stored per device as compact arrays in this field order.
export const SK = ["t", "w5", "p5", "ww", "pwr", "cc", "wf", "pf", "x5", "r5", "x5f", "r5f", "xw", "rw", "xwf", "rwf",
  // appended later, so older readings simply don't have them: Sonnet+Haiku ("light") totals
  "x5l", "r5l", "xwl", "rwl",
  // …and the collector's price-table version (missing = 1; see PRICE_VERSION in the collector)
  "pv"];
const SAMPLES_MAX = 4000;         // per device, hard cap; compact() keeps lists well below it
const COMPACT_AT = 2500;          // a laptop's list is compacted (at its own refit) past this
const FIT_EVERY_MS = 15 * 60e3;   // refitting reads every device's readings, so not on every sync
const LINE_MAX = 4000;            // ~2 days even with busy 2-minute syncs; /api/state sends a thinned 26 h
const SAMPLES_PER_POST = 3000;    // after an outage the collector catches up in batches of up to ~900 KB
const SKEW_MS = 10 * 60e3;        // how far a laptop's clock may be off the hub's
const SPAN_MS = 8 * 864e5;        // reset times and readings further than this from now are nonsense

const pack = (s) => SK.map((k) => s[k] ?? null);
export const unpack = (a) => Object.fromEntries(SK.map((k, i) => [k, a[i]]));
const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const tryParse = (v) => { try { return parse(v); } catch { return null; } };

// ---- What a laptop may send. Only these fields are stored (a new collector field needs adding
// here), each cut to its expected shape; see the helpers in _lib.js.
const n0 = num(0, 1e12);          // counts and tokens: never negative
const usd = num(0, 1e6);          // API-$ (x, r): even a laptop's all-time total is in the thousands
const usage = obj({ calls: n0, tokens: n0, x: usd, r: usd });
const totals = obj({ calls: n0, tokens: n0, x: usd, r: usd,
  by_platform: map(id(40), usage, 20), by_project: map(text(100), usage, 200), by_model: map(id(60), usage, 40) });
const stat = obj({ calls: n0, x: usd, r: usd, ctx: n0, model: id(60) });
const session = obj({ id: id(16), title: text(200), project: text(100), platform: text(80), start: when, last: when,
  calls: n0, x: usd, r: usd, tokens: n0, current_model: id(60), models: map(id(60), usage, 20),
  changes: list(obj({ t: when, model: id(60) }), 12), switches: list(obj({ t: when, to: text(80) }), 12),
  agents: list(obj({ id: id(16), type: text(60), desc: text(200), parent: id(40), depth: n0, calls: n0, x: usd, r: usd,
    tokens: n0, models: list(id(60), 10), first: when, last: when }), 25),
  ctx_max: n0, ctx_last: n0, ctx_avg: n0, recent: stat,
  // collector v4.1: this week's part of the session per model, and what one typed prompt costs
  week_models: map(id(60), obj({ x: usd, r: usd }), 20),
  recent_prompt: obj({ prompts: n0, x: usd, r: usd, fam: map(id(20), obj({ x: usd, r: usd }), 10) }),
  compactions: list(obj({ t: when, trigger: id(20), pre: n0, post: n0 }), 50) });
export const cleanSnapshot = obj({ person: text(40), host: text(60), sent_at: when, version: num(0, 1e3), pv: num(1, 99),
  official_error: text(300), windows_from_hub: bool, account: id(16), window_start: when, week_start: when,
  last_activity: when, window: totals, week: totals, hourly: map(when, obj({ x: usd, r: usd, xf: usd, rf: usd }), 400), sessions: list(session, 40) });
export const cleanDetail = obj({
  daily: map(day, obj({ models: map(id(60), list(n0, 5, true), 40), hours: list(n0, 24, true), msgs: n0, sessions: n0 }), 3000),
  context: obj({ buckets: list(obj({ lo: n0, hi: n0, calls: n0, x: usd, r: usd, by_fam: map(id(20), list(n0, 3, true), 10) }), 20),
    after_compact: list(stat, 40) }),
  chats: list(obj({ id: id(16), len: n0, cost: n0, model: id(60), effort: text(30), est: bool, in_project: bool, t: when }), 80) });

/** The official limits, or null if any part is off. They set every window id and every % the fit
 *  learns from, so a half-valid reading is worse than none (another laptop covers it). */
export function cleanOfficial(o, now = Date.now()) {
  if (!plain(o)) return null;
  const lim = (l, named) => {                 // null: not sent; undefined: invalid
    if (l == null) return null;
    if (!plain(l) || (l.pct != null && (typeof l.pct !== "number" || pct(l.pct) == null))) return undefined;
    const at = {};
    for (const k of ["resets_at", "resets_exact"]) {
      if (l[k] == null) { at[k] = null; continue; }
      if (!(Math.abs(Date.parse(when(l[k])) - now) <= SPAN_MS)) return undefined;
      at[k] = l[k];
    }
    return { ...(named ? { name: text(60)(l.name) } : {}), pct: pct(l.pct), ...at, severity: id(20)(l.severity) };
  };
  const five = lim(o.five_hour), week = lim(o.seven_day);
  const scoped = (Array.isArray(o.scoped) ? o.scoped.slice(0, 10) : []).map((l) => lim(l, true));
  if (five === undefined || week === undefined || scoped.includes(undefined)) return null;
  return { five_hour: five, seven_day: week, scoped: scoped.filter(Boolean),
    breakdown: list(obj({ key: id(40), name: text(60), percent: pct }), 10)(o.breakdown),
    breakdown_as_of: when(o.breakdown_as_of) || day(o.breakdown_as_of), plan: id(60)(o.plan) };
}

// Per reading field: window ids are dates, p-fields are %s, pv the price table; the rest are API-$.
const SAMPLE = { w5: when, ww: when, wf: when, p5: pct, pwr: pct, cc: pct, pf: pct, pv: num(1, 99) };
/** One reading with every field checked, or null if its time isn't a date. Refit runs it over the
 *  stored readings too, so a bad row stored before this check existed can't break the fit. */
export function cleanSample(s) {
  if (!plain(s) || !when(s.t)) return null;
  return Object.fromEntries(SK.map((k) => [k, k === "t" ? s.t : s[k] == null ? null : (SAMPLE[k] || usd)(s[k])]));
}
/** A device's stored list, oldest first, each row re-checked; rows that don't parse are dropped. */
export const readings = (list) =>
  (list || []).map(tryParse).filter(Array.isArray).map(unpack).map(cleanSample).filter(Boolean).sort((a, b) => a.t.localeCompare(b.t));

/** Older readings carry less news: past the last two days keep, per window, every reading where
 *  the official % moved plus up to 60 spread evenly (the fit thins to 60 per window anyway). */
export function compact(list, now = Date.now()) {
  const keep = [], old = {};
  for (const s of list) {
    if (now - Date.parse(s.t) < 2 * 864e5 || !s.w5) keep.push(s);
    else (old[s.w5] ||= []).push(s);
  }
  for (const win of Object.values(old)) {
    const idx = new Set([0, win.length - 1]);
    for (let i = 1; i < win.length; i++) if (win[i].p5 !== win[i - 1].p5) idx.add(i);
    for (let i = 0; i < 60; i++) idx.add(Math.round((i * (win.length - 1)) / 59));
    keep.push(...[...idx].sort((a, b) => a - b).map((i) => win[i]));
  }
  return keep.sort((a, b) => a.t.localeCompare(b.t));
}

/** Refit on every device's readings and store it; also keep the week's split for the history.
 *  `own` is the device whose ingest triggered this: its list is compacted when it's long (only
 *  its own — it can't be appending while its own request is running). */
export async function refit(names, own = null) {
  const q = redis.pipeline();
  for (const n of names) q.lrange(`ds:${n}`, 0, -1);
  q.hgetall("devices").get("week:current").get("forecast:ignore").get("fit");
  const got = await q.exec();
  const lists = got.slice(0, names.length), [all, current, ignoreRaw, prevFitRaw] = got.slice(names.length);
  const ignore = parse(ignoreRaw) || [], prevFit = parse(prevFitRaw);
  const perDevice = Object.fromEntries(names.map((n, i) => [n, readings(lists[i])]));
  // φ carries over from fit to fit: once the Fable-heavy windows are gone, the last learned value
  // is the prior (not a hard-coded 3), and an unlearned one isn't passed off as learned.
  const pf = prevFit?.five, phiPrior = pf?.phi_learned ? pf.phi : pf?.phi_prior;
  const fit = fitDevices(perDevice, phiPrior ? { phiPrior } : {});
  fit.week_hours = weekHours(perDevice, Date.now(), ignore);   // recent official pace, for the forecast
  fit.fable_hours = weekHours(perDevice, Date.now(), ignore, "pf", "wf");
  // Live: how much of the running session no synced laptop logged (claude.ai, another computer).
  try { fit.unlogged = unloggedPath(perDevice, fit); } catch (e) { console.error("unlogged path failed:", e); }
  const w = redis.pipeline().set("fit", fit);
  if (own && perDevice[own]?.length > COMPACT_AT) {
    const kept = compact(perDevice[own]);
    w.del(`ds:${own}`).rpush(`ds:${own}`, ...kept.map((s) => JSON.stringify(pack(s))));
  }
  // Weekly history: the latest split of the running week, and when the week id moves on, the
  // previous week's last split goes into `weeks` (as of the last refit before the reset).
  const devices = Object.values(all || {}).map(parse);
  const off = freshestOfficial(devices)?.official;
  if (off?.seven_day?.resets_at) {
    const id = off.seven_day.resets_exact || off.seven_day.resets_at;
    const { people, elsewhere } = split(devices, fit, off);
    const prev = parse(current);
    const rolled = prev?.id && Math.abs(Date.parse(prev.id) - Date.parse(id)) > 36e5;
    // Two refits racing at the reset would both see the rollover: archive each week once.
    if (rolled && await redis.set(`week:archived:${prev.id}`, 1, { nx: true, ex: 60 * 86400 }))
      w.rpush("weeks", JSON.stringify(prev)).ltrim("weeks", -60, -1);
    // Forecast track record: what the forecast said, every 6 h, kept with the week so it can be
    // scored against the week's end. `avg` is what the old average-pace method would have said.
    const forecasts = rolled || !prev ? [] : prev.forecasts || [];
    const fc = forecastWeek(off.seven_day, fit.week_hours);
    const last = forecasts[forecasts.length - 1];
    if (fc && !fc.early && fc.expected != null && (!last || Date.now() - Date.parse(last.at) >= 6 * 36e5)) {
      // the old method with the same one-off handling, so the comparison is like for like
      const same = Object.values(perDevice).flat().filter((s) => s.pwr != null && s.ww && Math.abs(Date.parse(s.ww) - Date.parse(id)) < 10 * 60e3)
        .sort((a, b) => a.t.localeCompare(b.t));
      forecasts.push({ at: new Date().toISOString(), pct: fc.pct, expected: +fc.expected.toFixed(1), lo: +fc.lo.toFixed(1), hi: +fc.hi.toFixed(1),
        p: fc.p_limit, avg: +averageForecast(same, fc.pct, Date.now(), Date.parse(id), ignore).toFixed(1) });
    }
    w.set("week:current", JSON.stringify({ id, at: new Date().toISOString(), week: off.seven_day.pct, forecasts,
      fable: (off.scoped || []).find((x) => /fable/i.test(x.name))?.pct ?? null,
      breakdown: (off.breakdown || []).map((b) => ({ key: b.key, percent: b.percent })),
      people: people.map((x) => ({ person: x.person, week: +x.week.toFixed(2), fable: +x.fable.toFixed(2) })),
      elsewhere: elsewhere && { week: +elsewhere.week.toFixed(2), fable: elsewhere.fable == null ? null : +elsewhere.fable.toFixed(2) },
      err: fit.week?.err ?? null }));
  }
  await w.exec();
  return fit;
}

// Older collectors send no readings: derive one from the snapshot's window totals.
function fromSnapshot(snap) {
  const off = snap.official, fable = (off.scoped || []).find((s) => /fable/i.test(s.name));
  const sum = (key, fam) => {
    let x = 0, r = 0;
    for (const [m, v] of Object.entries(snap[key]?.by_model || {})) if (!fam || family(m) === fam) { x += v.x || 0; r += v.r || 0; }
    return [x, r];
  };
  const [x5, r5] = sum("window"), [x5f, r5f] = sum("window", "fable"), [xw, rw] = sum("week"), [xwf, rwf] = sum("week", "fable");
  return { t: snap.received_at, w5: off.five_hour.resets_at, p5: off.five_hour.pct, ww: off.seven_day?.resets_at, pwr: off.seven_day?.pct,
    cc: off.breakdown?.find((b) => b.key === "claude_code")?.percent ?? null, wf: fable?.resets_at, pf: fable?.pct,
    x5, r5, x5f, r5f, xw, rw, xwf, rwf };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const who = viewer(req);
  if (!who) return res.status(401).json({ error: "bad key" });
  const raw = plain(req.body) ? req.body : {};
  const label = text(60)(String(raw.device ?? "")) || "";
  const device = slug(label);
  if (!device) return res.status(400).json({ error: "device required" });
  // received_at is the hub's own clock and the one every "which is newest" choice uses; sent_at
  // is only shown, but a laptop claiming to be from the future would look online forever.
  const now = Date.now(), sent = Date.parse(when(raw.sent_at));
  if (Math.abs(sent - now) > SKEW_MS)
    return res.status(400).json({ error: `sent_at is ${Math.round((sent - now) / 60e3)} min off the hub's clock: set this laptop's clock` });
  const snap = { ...cleanSnapshot(raw), device, label, received_at: new Date(now).toISOString(), official: cleanOfficial(raw.official, now) };
  snap.sent_at ||= snap.received_at;
  // A personal key can only ever file usage under its own owner, and only on a laptop that is
  // its own: the first sync claims a device name, and another person's key can't write to it
  // (a copied config or a clashing name would otherwise overwrite someone else's laptop).
  if (who !== "*") {
    snap.person = who;
    const owner = await redis.hget("owner", device);
    if (owner && owner !== who) return res.status(403).json({ error: `"${label}" belongs to ${owner}: pick another device name` });
    if (!owner) await redis.hsetnx("owner", device, who);
  }

  // Readings go straight into the fit: each is checked, and one timed outside the plausible span
  // (a week back to a few minutes ahead) is dropped.
  const samples = [];
  let dropped = 0;
  for (const s of Array.isArray(raw.samples) ? raw.samples.slice(-SAMPLES_PER_POST) : []) {
    const c = cleanSample(s), t = c ? Date.parse(c.t) : NaN;
    if (t > now - SPAN_MS && t < now + SKEW_MS) samples.push(c); else dropped++;
  }
  if (Array.isArray(raw.samples)) dropped += Math.max(0, raw.samples.length - SAMPLES_PER_POST);
  if (!raw.samples && snap.official?.five_hour) samples.push(cleanSample(fromSnapshot(snap)));
  // The heavy all-time parts go to their own hash, read only by /api/detail.
  const detail = cleanDetail({ daily: raw.daily, context: raw.context, chats: raw.chats });

  const p = redis.pipeline()
    .set("stamp", snap.received_at)       // lets the dashboard skip reloads when nothing changed
    .hset("devices", { [device]: JSON.stringify(snap) })
    .hset("detail", { [device]: JSON.stringify(detail) });
  if (samples.length) p.rpush(`ds:${device}`, ...samples.map((s) => JSON.stringify(pack(s)))).ltrim(`ds:${device}`, -SAMPLES_MAX, -1);
  if (snap.official?.five_hour)
    p.rpush("line", JSON.stringify({ t: snap.received_at, five: snap.official.five_hour.pct, week: snap.official.seven_day?.pct ?? null,
      r5: snap.official.five_hour.resets_exact || snap.official.five_hour.resets_at || null })).ltrim("line", -LINE_MAX, -1);
  p.hget("pv", device).get("fit").hkeys("devices");
  const out = await p.exec();
  const storedPv = Number(out[out.length - 3] || 1), fit = out[out.length - 2], names = out[out.length - 1] || [];

  // Refit on a schedule (or right away if there's no fit yet). The sync above is already stored,
  // so a fit that throws is logged and retried at the next sync instead of failing this one.
  // One refit at a time: two laptops syncing together would otherwise both refit (double the
  // CPU, and both could archive the week at a reset).
  if ((!fit?.at || Date.now() - new Date(fit.at) > FIT_EVERY_MS) && await redis.set("fit:lock", device, { nx: true, ex: 60 })) {
    try { await refit(names, device); } catch (e) { console.error("refit failed:", e); }
    finally { await redis.del("fit:lock"); }
  }
  // This laptop now prices usage with a newer table than its stored readings were: ask it to
  // reprice them from its logs (it answers at /api/reprice), so old and new readings agree.
  let reprice;
  if ((snap.pv || 1) > storedPv) {
    const held = readings(await redis.lrange(`ds:${device}`, 0, -1));
    reprice = held.filter((s) => (s.pv || 1) < snap.pv).map((s) => [s.t, s.w5, s.ww, s.wf]);
    if (!reprice.length) { await redis.hset("pv", { [device]: snap.pv }); reprice = undefined; }
  }
  // The learned rates, so a laptop can price its own sessions without another request.
  const r = (f) => f?.a != null ? { a: f.a, b: f.b ?? f.a, m: f.m || {}, err: f.err ?? null } : null;
  res.status(200).json({ ok: true, device, samples: samples.length, ...(dropped ? { dropped } : {}),
    rate: { five: r(fit?.five), week: r(fit?.week) }, ...(reprice ? { reprice } : {}) });
}
