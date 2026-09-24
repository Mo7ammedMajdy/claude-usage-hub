import { redactDetail, redis, viewer } from "./_lib.js";

const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);

// All-time per-device history (daily stats, context-window and compaction analysis).
// Heavier than /api/state, so the dashboard fetches it rarely.
export default async function handler(req, res) {
  const who = viewer(req);
  if (!who) return res.status(401).json({ error: "bad key" });
  // `devices` only to learn whose laptop each one is, for the redaction below.
  const [all, devices] = await redis.pipeline().hgetall("detail").hgetall("devices").exec();
  const owner = (dev) => {
    const d = parse((devices || {})[dev] || null);
    return d?.person || d?.label || dev;
  };
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(Object.fromEntries(
    Object.entries(all || {}).map(([dev, v]) => [dev, redactDetail(parse(v), owner(dev), who)])));
}
