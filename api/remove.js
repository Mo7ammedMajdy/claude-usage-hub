import { redis, slug, viewer } from "./_lib.js";

// POST /api/remove {"device": "<name or id>"} — drop a renamed or retired device from the hub.
// A personal key can only remove its own laptops; the master key can remove any.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const who = viewer(req);
  if (!who) return res.status(401).json({ error: "bad key" });
  const device = slug(req.body?.device);
  if (!device) return res.status(400).json({ error: "device required" });
  if (who !== "*") {
    const owner = await redis.hget("owner", device);
    if (owner && owner !== who) return res.status(403).json({ error: "not your laptop" });
  }
  await redis.pipeline().hdel("devices", device).hdel("detail", device).del(`ds:${device}`).hdel("owner", device).hdel("pv", device).exec();
  res.status(200).json({ ok: true, removed: device });
}
