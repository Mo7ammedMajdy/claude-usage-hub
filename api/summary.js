import { family, redact, redis, slug, viewer } from "./_lib.js";

// The small view the claude.ai userscript needs: the official limits, each person's estimated
// share, the learned rates for pricing the next message, and the claude.ai chats seen so far.
// Same maths as the dashboard's estModels(), done here so the userscript stays thin.
const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);

// Pace forecast, as the dashboard's pace(): the average rate since the window opened, carried
// to its reset. `hours` is the window's length.
function pace(lim, hours, now) {
  const at = lim?.resets_exact || lim?.resets_at;      // exact when the collector sends it
  if (!at || lim.pct == null) return null;
  const reset = Date.parse(at);
  const elapsedH = Math.max(0.25, hours - (reset - now) / 36e5);
  const rate = lim.pct / elapsedH;
  const runOut = rate > 0 ? now + ((100 - lim.pct) / rate) * 36e5 : null;
  return { pct: lim.pct, resets_at: at, elapsed_h: elapsedH, per_day: rate * 24,
    projected: lim.pct + rate * Math.max(0, reset - now) / 36e5,
    runs_out_at: runOut != null && runOut < reset && lim.pct < 100 ? new Date(runOut).toISOString() : null };
}

const estimate = (byModel, f) => f?.a == null || !byModel ? null
  : Object.entries(byModel).reduce((s, [m, v]) => s + (f.m?.[family(m)] ?? 1) * (f.a * (v.x || 0) + (f.b ?? f.a) * (v.r || 0)), 0);

export default async function handler(req, res) {
  const who = viewer(req);
  if (!who) return res.status(401).json({ error: "bad key" });
  const [all, fit, people, line] = await redis.pipeline().hgetall("devices").get("fit").smembers("webpeople").lrange("line", 0, -1).exec();
  const devices = Object.values(all || {}).map((d) => redact(parse(d), who));
  const fresh = devices.filter((d) => d.official?.five_hour).sort((a, b) => (b.sent_at || "").localeCompare(a.sent_at || ""))[0];
  const five = fit?.five, week = fit?.week, fable = fit?.fable;

  const byPerson = {};
  for (const d of devices) {
    const p = (byPerson[d.person] ||= { person: d.person, five: 0, week: 0, fable: 0, calibrated: five?.a != null, fable_calibrated: fable?.a != null });
    p.five += estimate(d.window?.by_model, five) || 0;
    p.week += estimate(d.week?.by_model, week) || 0;
    // Fable has its own weekly limit and its own fit; only Fable calls count toward it (as the
    // dashboard's scopedSplit does).
    if (fable?.a != null) for (const [m, v] of Object.entries(d.week?.by_model || {}))
      if (family(m) === "fable") p.fable += fable.a * (v.x || 0) + (fable.b ?? fable.a) * (v.r || 0);
  }

  const web = {};
  if ((people || []).length) {
    const q = redis.pipeline();
    for (const p of people) q.hgetall(`webchat:${slug(p)}`);
    const got = await q.exec();
    people.forEach((p, i) => {
      web[p] = Object.values(got[i] || {}).map(parse).sort((a, b) => (b.last || "").localeCompare(a.last || "")).slice(0, 30);
    });
  }

  const off = fresh?.official || null;
  const now = Date.now();
  let forecast = null;
  const wk = off && pace(off.seven_day, 168, now);
  if (wk) {
    // Recent burn from the 5-minute line, when it spans 3+ hours without a weekly reset.
    const pts = (line || []).map((v) => (typeof v === "string" ? JSON.parse(v) : v))
      .filter((h) => h.week != null && now - Date.parse(h.t) < 24 * 36e5).sort((a, b) => a.t.localeCompare(b.t));
    let recent = null;
    if (pts.length >= 2) {
      const a = pts[0], b = pts[pts.length - 1], span = (Date.parse(b.t) - Date.parse(a.t)) / 36e5;
      if (span >= 3 && b.week >= a.week) recent = { span_h: span, per_day: (b.week - a.week) / span * 24 };
    }
    forecast = { week: wk, recent,
      scoped: (off.scoped || []).map((x) => ({ name: x.name, ...pace(x, 168, now) })).filter((x) => x.runs_out_at) };
  }
  const sum = (k) => Object.values(byPerson).reduce((s, p) => s + p[k], 0);
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    now: new Date().toISOString(), viewer: who,
    official: off && { five: off.five_hour, week: off.seven_day, scoped: off.scoped, breakdown: off.breakdown, read_at: fresh.sent_at },
    people: Object.values(byPerson),
    elsewhere: off && five?.a != null ? {
      five: Math.max(0, (off.five_hour?.pct ?? 0) - sum("five")), week: Math.max(0, (off.seven_day?.pct ?? 0) - sum("week")),
      fable: fable?.a != null ? Math.max(0, ((off.scoped || []).find((x) => /fable/i.test(x.name))?.pct ?? 0) - sum("fable")) : null,
    } : null,
    // For pricing a message: % of the session per API-$ of non-cache tokens (a), of cache reads
    // (b), and the per-family weights. The userscript turns a context size into a %.
    forecast,
    rate: five?.a != null ? { a: five.a, b: five.b ?? five.a, m: five.m || {}, err: five.err ?? null } : null,
    web,
  });
}
