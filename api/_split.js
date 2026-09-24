import { family } from "./_lib.js";

// Each person's estimated share of the official limits, from their laptops' logged usage and
// the learned rates — what /api/summary shows live and what the weekly history keeps.
const estimate = (byModel, f) => f?.a == null || !byModel ? null
  : Object.entries(byModel).reduce((s, [m, v]) => s + (f.m?.[family(m)] ?? 1) * (f.a * (v.x || 0) + (f.b ?? f.a) * (v.r || 0)), 0);

export function split(devices, fit, off) {
  const five = fit?.five, week = fit?.week, fable = fit?.fable;
  const byPerson = {};
  for (const d of devices) {
    const p = (byPerson[d.person] ||= { person: d.person, five: 0, week: 0, fable: 0, calibrated: five?.a != null, fable_calibrated: fable?.a != null });
    p.five += estimate(d.window?.by_model, five) || 0;
    p.week += estimate(d.week?.by_model, week) || 0;
    // Fable has its own weekly limit and its own fit; only Fable calls count toward it.
    if (fable?.a != null) for (const [m, v] of Object.entries(d.week?.by_model || {}))
      if (family(m) === "fable") p.fable += fable.a * (v.x || 0) + (fable.b ?? fable.a) * (v.r || 0);
  }
  const people = Object.values(byPerson);
  const sum = (k) => people.reduce((s, p) => s + p[k], 0);
  const elsewhere = off && five?.a != null ? {
    five: Math.max(0, (off.five_hour?.pct ?? 0) - sum("five")), week: Math.max(0, (off.seven_day?.pct ?? 0) - sum("week")),
    fable: fable?.a != null ? Math.max(0, ((off.scoped || []).find((x) => /fable/i.test(x.name))?.pct ?? 0) - sum("fable")) : null,
  } : null;
  return { people, elsewhere };
}

/** Newest device snapshot that carries the official limits. */
export const freshestOfficial = (devices) =>
  devices.filter((d) => d.official?.five_hour).sort((a, b) => (b.sent_at || "").localeCompare(a.sent_at || ""))[0];
