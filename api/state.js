import { redact, redis, viewer } from "./_lib.js";

const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);

export default async function handler(req, res) {
  const who = viewer(req);
  if (!who) return res.status(401).json({ error: "bad key" });
  // The fit is computed at ingest time (api/_fit.js), so a dashboard read stays cheap.
  const [all, fit, line, refresh, weeks, current] = await redis.pipeline()
    .hgetall("devices").get("fit").lrange("line", 0, -1).get("refresh").lrange("weeks", 0, -1).get("week:current").exec();
  const empty = { a: null, n: 0, span: 0, need: 3 };
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    now: new Date().toISOString(),
    devices: Object.values(all || {}).map((d) => redact(parse(d), who)),
    line: (line || []).map(parse),
    refresh_requested_at: refresh || null,
    viewer: who,
    // Past weeks' final split (newest last) and the running week's latest.
    weeks: [...(weeks || []).map(parse), ...(current ? [{ ...parse(current), running: true }] : [])],
    model: { five: fit?.five || empty, week: fit?.week || empty, fable: fit?.fable || empty, devices: fit?.devices || {} },
    // Past 5-hour windows: final official % and each laptop's estimated share (from the fit).
    windows5: fit?.windows5 || [],
  });
}
