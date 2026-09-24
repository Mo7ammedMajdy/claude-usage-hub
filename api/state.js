import { redact, redis, viewer } from "./_lib.js";

const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);

export default async function handler(req, res) {
  const who = viewer(req);
  if (!who) return res.status(401).json({ error: "bad key" });
  // The fit is computed at ingest time (api/_fit.js), so a dashboard read stays cheap.
  const [all, fit, line, refresh] = await redis.pipeline()
    .hgetall("devices").get("fit").lrange("line", 0, -1).get("refresh").exec();
  const empty = { a: null, n: 0, span: 0, need: 3 };
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    now: new Date().toISOString(),
    devices: Object.values(all || {}).map((d) => redact(parse(d), who)),
    line: (line || []).map(parse),
    refresh_requested_at: refresh || null,
    viewer: who,
    model: { five: fit?.five || empty, week: fit?.week || empty, fable: fit?.fable || empty, devices: fit?.devices || {} },
  });
}
