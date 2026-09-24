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
