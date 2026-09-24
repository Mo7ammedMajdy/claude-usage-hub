import { redact, redis, viewer } from "./_lib.js";

const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);

// The chart needs the last 24 h, and a run of identical readings only needs its two ends
// (the line is straight between them either way).
function thinLine(pts) {
  const since = Date.now() - 26 * 36e5, recent = pts.filter((h) => Date.parse(h.t) >= since);
  const same = (a, b) => a && b && a.five === b.five && a.week === b.week && a.r5 === b.r5;
  return recent.filter((h, i) => !(same(recent[i - 1], h) && same(h, recent[i + 1])));
}

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
    line: thinLine((line || []).map(parse)),
    refresh_requested_at: refresh || null,
    viewer: who,
    // Past weeks' final split (newest last) and the running week's latest.
    weeks: [...(weeks || []).map(parse), ...(current ? [{ ...parse(current), running: true }] : [])],
    model: { five: fit?.five || empty, week: fit?.week || empty, fable: fit?.fable || empty, devices: fit?.devices || {} },
    // Past 5-hour windows: final official % and each laptop's estimated share (from the fit).
    windows5: fit?.windows5 || [],
  });
}
