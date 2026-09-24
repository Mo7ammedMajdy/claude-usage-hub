import { redis, slug, viewer, num, when } from "./_lib.js";
import { SK, refit, readings } from "./ingest.js";

// A laptop sends its stored readings back, repriced with its current price table (see
// /api/ingest's `reprice`). Only the logged totals change; the official %s and times stay.
const FIELDS = ["x5", "r5", "x5f", "r5f", "x5l", "r5l", "xw", "rw", "xwf", "rwf", "xwl", "rwl"];
const ROWS_MAX = 4000;            // a device never holds more readings than this (SAMPLES_MAX)
const dollars = num(0, 1e6);
const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const who = viewer(req);
  if (!who) return res.status(401).json({ error: "bad key" });
  const device = slug(String(req.body?.device || "").slice(0, 60));
  const pv = num(2, 99)(req.body?.pv);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, ROWS_MAX) : [];
  if (!device || pv == null) return res.status(400).json({ error: "device and pv required" });
  const [snap, list, names] = await redis.pipeline().hget("devices", device).lrange(`ds:${device}`, 0, -1).hkeys("devices").exec();
  const owner = parse(snap)?.person;
  if (who !== "*" && owner !== who) return res.status(403).json({ error: "not your laptop" });

  // Match on the reading time as a moment (the laptop re-serialises it).
  const byT = new Map(rows.filter((r) => Array.isArray(r) && r.length === 13 && when(r[0])).map((r) => [Date.parse(r[0]), r]));
  let updated = 0;
  const next = readings(list).map((s) => {
    const row = byT.get(Date.parse(s.t));
    if (!row || (s.pv || 1) >= pv) return s;
    updated++;
    return { ...s, ...Object.fromEntries(FIELDS.map((k, i) => [k, dollars(row[i + 1]) ?? 0])), pv };
  });
  // Readings that couldn't be repriced (their logs are gone) keep their old table; the fit
  // keeps them in separate windows from repriced ones.
  const t = redis.multi().del(`ds:${device}`);
  if (next.length) t.rpush(`ds:${device}`, ...next.map((s) => JSON.stringify(SK.map((k) => s[k] ?? null))));
  t.hset("pv", { [device]: pv });
  await t.exec();
  // The repriced readings are stored either way; a fit that throws is logged and the next sync retries.
  let fit = null;
  try { fit = await refit(names || []); } catch (e) { console.error("refit failed:", e); }
  res.status(200).json({ ok: true, device, updated, of: next.length, rate_five: fit?.five?.a ?? null });
}
