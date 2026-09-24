import { viewer, redis, slug, family } from "./_lib.js";
import { fitDevices } from "./_fit.js";
import { freshestOfficial, split } from "./_split.js";
export { combine } from "./_combine.js";

// Calibration readings are stored per device as compact arrays in this field order.
export const SK = ["t", "w5", "p5", "ww", "pwr", "cc", "wf", "pf", "x5", "r5", "x5f", "r5f", "xw", "rw", "xwf", "rwf",
  // appended later, so older readings simply don't have them: Sonnet+Haiku ("light") totals
  "x5l", "r5l", "xwl", "rwl",
  // …and the collector's price-table version (missing = 1; see PRICE_VERSION in the collector)
  "pv"];
const SAMPLES_MAX = 1500;         // per device
const FIT_EVERY_MS = 15 * 60e3;   // refitting reads every device's readings, so not on every sync
const LINE_MAX = 2 * 24 * 12 * 2;

const pack = (s) => SK.map((k) => s[k] ?? null);
export const unpack = (a) => Object.fromEntries(SK.map((k, i) => [k, a[i]]));
const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);

/** Refit on every device's readings and store it; also keep the week's split for the history. */
export async function refit(names) {
  const q = redis.pipeline();
  for (const n of names) q.lrange(`ds:${n}`, 0, -1);
  q.hgetall("devices").get("week:current");
  const got = await q.exec();
  const lists = got.slice(0, names.length), [all, current] = got.slice(names.length);
  const perDevice = Object.fromEntries(names.map((n, i) => [n, (lists[i] || []).map(parse).map(unpack).sort((a, b) => a.t.localeCompare(b.t))]));
  const fit = fitDevices(perDevice);
  const w = redis.pipeline().set("fit", fit);
  // Weekly history: the latest split of the running week, and when the week id moves on, the
  // previous week's last split goes into `weeks` (as of the last refit before the reset).
  const devices = Object.values(all || {}).map(parse);
  const off = freshestOfficial(devices)?.official;
  if (off?.seven_day?.resets_at) {
    const id = off.seven_day.resets_exact || off.seven_day.resets_at;
    const { people, elsewhere } = split(devices, fit, off);
    const prev = parse(current);
    if (prev?.id && Math.abs(Date.parse(prev.id) - Date.parse(id)) > 36e5) w.rpush("weeks", JSON.stringify(prev)).ltrim("weeks", -60, -1);
    w.set("week:current", JSON.stringify({ id, at: new Date().toISOString(), week: off.seven_day.pct,
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
  const snap = req.body;
  const label = String(snap?.device || "").slice(0, 60);
  const device = slug(label);
  if (!device) return res.status(400).json({ error: "device required" });
  Object.assign(snap, { device, label, received_at: new Date().toISOString() });
  // A personal key can only ever file usage under its own owner, and only on a laptop that is
  // its own: the first sync claims a device name, and another person's key can't write to it
  // (a copied config or a clashing name would otherwise overwrite someone else's laptop).
  if (who !== "*") {
    snap.person = who;
    const owner = await redis.hget("owner", device);
    if (owner && owner !== who) return res.status(403).json({ error: `"${label}" belongs to ${owner}: pick another device name` });
    if (!owner) await redis.hsetnx("owner", device, who);
  }

  let samples = snap.samples || [];
  if (!snap.samples && snap.official?.five_hour) samples = [fromSnapshot(snap)];
  // The heavy all-time parts go to their own hash, read only by /api/detail.
  const detail = { daily: snap.daily, context: snap.context, chats: snap.chats };
  delete snap.samples; delete snap.daily; delete snap.context; delete snap.chats;

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

  // Refit on a schedule (or right away if there's no fit yet).
  if (!fit?.at || Date.now() - new Date(fit.at) > FIT_EVERY_MS) await refit(names);
  // This laptop now prices usage with a newer table than its stored readings were: ask it to
  // reprice them from its logs (it answers at /api/reprice), so old and new readings agree.
  let reprice;
  if ((snap.pv || 1) > storedPv) {
    const held = ((await redis.lrange(`ds:${device}`, 0, -1)) || []).map(parse).map(unpack);
    reprice = held.filter((s) => (s.pv || 1) < snap.pv).map((s) => [s.t, s.w5, s.ww, s.wf]);
    if (!reprice.length) { await redis.hset("pv", { [device]: snap.pv }); reprice = undefined; }
  }
  // The learned rates, so a laptop can price its own sessions without another request.
  const r = (f) => f?.a != null ? { a: f.a, b: f.b ?? f.a, m: f.m || {}, err: f.err ?? null } : null;
  res.status(200).json({ ok: true, device, samples: samples.length, rate: { five: r(fit?.five), week: r(fit?.week) }, ...(reprice ? { reprice } : {}) });
}
