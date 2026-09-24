import { authorized, redis, slug } from "./_lib.js";

// POST /api/remove {"device": "<name or id>"} — drop a renamed or retired device from the hub.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (!authorized(req)) return res.status(401).json({ error: "bad key" });
  const device = slug(req.body?.device);
  if (!device) return res.status(400).json({ error: "device required" });
  await redis.pipeline().hdel("devices", device).hdel("detail", device).del(`ds:${device}`).exec();
  res.status(200).json({ ok: true, removed: device });
}
