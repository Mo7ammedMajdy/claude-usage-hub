import { authorized, redis } from "./_lib.js";

// POST: the dashboard asks every device to sync now. GET: devices poll this (~every 30 s).
export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: "bad key" });
  if (req.method === "POST") {
    const at = new Date().toISOString();
    await redis.set("refresh", at);
    return res.status(200).json({ requested_at: at });
  }
  res.setHeader("Cache-Control", "no-store");
  // One command for both: laptops look at requested_at, the dashboard at stamp (newest sync).
  const [requested_at, stamp] = await redis.mget("refresh", "stamp");
  res.status(200).json({ requested_at, stamp });
}
