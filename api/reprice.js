import { redis, slug, viewer } from "./_lib.js";
import { SK, refit, unpack } from "./ingest.js";

// A laptop sends its stored readings back, repriced with its current price table (see
// /api/ingest's `reprice`). Only the logged totals change; the official %s and times stay.
const FIELDS = ["x5", "r5", "x5f", "r5f", "x5l", "r5l", "xw", "rw", "xwf", "rwf", "xwl", "rwl"];
const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const who = viewer(req);
  if (!who) return res.status(401).json({ error: "bad key" });
  const device = slug(String(req.body?.device || "").slice(0, 60));
  const pv = Number(req.body?.pv);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!device || !(pv >= 2)) return res.status(400).json({ error: "device and pv required" });
  const [snap, list, names] = await redis.pipeline().hget("devices", device).lrange(`ds:${device}`, 0, -1).hkeys("devices").exec();
  const owner = parse(snap)?.person;
  if (who !== "*" && owner !== who) return res.status(403).json({ error: "not your laptop" });

  // Match on the reading time as a moment (the laptop re-serialises it).
  const byT = new Map(rows.filter((r) => Array.isArray(r) && r.length === 13).map((r) => [Date.parse(r[0]), r]));
  let updated = 0;
  const next = (list || []).map(parse).map(unpack).map((s) => {
    const row = byT.get(Date.parse(s.t));
    if (!row || (s.pv || 1) >= pv) return s;
    updated++;
    return { ...s, ...Object.fromEntries(FIELDS.map((k, i) => [k, +row[i + 1] || 0])), pv };
  });
  // Readings that couldn't be repriced (their logs are gone) keep their old table; the fit
  // keeps them in separate windows from repriced ones.
  const t = redis.multi().del(`ds:${device}`);
  if (next.length) t.rpush(`ds:${device}`, ...next.map((s) => JSON.stringify(SK.map((k) => s[k] ?? null))));
  t.hset("pv", { [device]: pv });
  await t.exec();
  const fit = await refit(names || []);
  res.status(200).json({ ok: true, device, updated, of: next.length, rate_five: fit.five?.a ?? null });
}
