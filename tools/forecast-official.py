#!/usr/bin/env python3
"""The same forecast methods replayed on the account's official week % (the week ending
2026-09-25 01:00 UTC, readings from Sep 19 16:00). Final value taken as 83%."""
import json, os, statistics as st
from datetime import datetime, timedelta, timezone
HERE = os.path.dirname(os.path.abspath(__file__))
S = json.load(open(os.path.join(HERE, "fixtures", "readings-2026-09-24.json")))
P = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
pts = sorted((P(s["t"]), s["pwr"]) for L in S.values() for s in L if s.get("pwr") is not None and (s.get("ww") or "").startswith("2026-09-25"))
start = datetime(2026, 9, 18, 1, tzinfo=timezone.utc); reset = start + timedelta(days=7); FINAL = 83
def at(t):
    b = [p for x, p in pts if x <= t]; return b[-1] if b else None
def recent_rate(now, half_life_h, span_h):
    """Exponentially weighted % per hour over the last span_h hours (hourly increments)."""
    num = den = 0.0
    for k in range(span_h):
        a, b = at(now - timedelta(hours=k + 1)), at(now - timedelta(hours=k))
        if a is None or b is None: continue
        w = 0.5 ** (k / half_life_h); num += w * (b - a); den += w
    return num / den if den else None
rows = []
for h in range(60, 168, 12):
    now = start + timedelta(hours=h); pct = at(now); left = 168 - h
    m0 = pct + pct / h * left
    r1 = recent_rate(now, 36, 72); r2 = recent_rate(now, 24, 72)
    m1 = pct + r1 * left; m2 = pct + r2 * left
    mix = pct + (0.3 * pct / h + 0.7 * r1) * left
    rows.append((now, pct, m0, m1, m2, mix))
    print(f"{now:%a %H:%M}Z {pct:3.0f}%  avg-pace {m0:5.0f}  recent(hl36h) {m1:5.0f}  recent(hl24h) {m2:5.0f}  mix30/70 {mix:5.0f}")
for i, name in enumerate(["avg-pace", "recent hl36", "recent hl24", "mix"], 2):
    print(f"{name:12s} MAE {st.mean(abs(r[i] - FINAL) for r in rows):5.1f}")

# Independent cross-check of tools/forecast-pace.mjs (own increments, no repo code): the pace
# estimators every 2 h from Sep 21 12:00 to Sep 24 16:00, the Sep 18-20 spike left out of the pace
# (as Redis forecast:ignore has it), against a final of 83 and 84.
IGN = (datetime(2026, 9, 18, 1, tzinfo=timezone.utc), datetime(2026, 9, 20, 14, tzinfo=timezone.utc))
def pace(now, weight, span=72, ignore=True):
    num = den = 0.0
    for k in range(span):                        # k = 0: the last whole hour before `now`
        a0 = now - timedelta(hours=k + 1); a, b = at(a0), at(now - timedelta(hours=k))
        if a is None or b is None or (ignore and IGN[0] <= a0 < IGN[1]): continue
        w = weight(k); num += w * (b - a); den += w
    return num / den if den else None
EST = {"EW 30 h": lambda k: 0.5 ** (k / 30), "mean 72 h": lambda k: 1.0, "EW over day blocks": lambda k: 0.5 ** (24 * (k // 24) / 30)}
for ignore in (True, False):
    print(f"\nevery 2 h, Sep 21 12:00-Sep 24 16:00, spike {'ignored' if ignore else 'NOT ignored'}:")
    for name, wf in EST.items():
        errs = {F: [] for F in (83, 84)}
        now = datetime(2026, 9, 21, 12, tzinfo=timezone.utc)
        while now <= datetime(2026, 9, 24, 16, tzinfo=timezone.utc):
            r = pace(now, wf, ignore=ignore); left = (reset - now).total_seconds() / 3600
            if r is not None:
                for F in errs: errs[F].append(at(now) + r * left - F)
            now += timedelta(hours=2)
        print(f"  {name:20s} " + "  ".join(f"final {F}: MAE {st.mean(map(abs, e)):4.2f} bias {st.mean(e):+5.2f} (n={len(e)})" for F, e in errs.items()))
