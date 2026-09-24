#!/usr/bin/env python3
"""Back-test week-end forecasts on this laptop's logged history (tools/data/reqs.json from reqs.py).
Usage is turned into "% of the weekly limit" with the fitted rates, then each past week is replayed:
at every 12 h mark, each method predicts the week's final total, scored against what happened."""
import json, math, os, statistics as st
from collections import defaultdict
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "data", "reqs.json")))
PRICES = [("claude-fable-5-1", (10, 50, .25)), ("claude-fable", (10, 50, 1)), ("claude-opus-5-5", (4, 20, .2)),
          ("claude-opus", (5, 25, .5)), ("claude-sonnet-5", (2, 10, .2)), ("claude-sonnet", (3, 15, .3)), ("claude-haiku", (1, 5, .1))]
A_WEEK, RHO, PHI = 0.089, 0.5, 3.85
def pct(r):
    i, o, c = next((p for pre, p in PRICES if r["model"].startswith(pre)), (5, 25, .5))
    x = (r["in"] * i + r["out"] * o + (r["cw"] - r["c1h"]) * i * 1.25 + r["c1h"] * i * 2) / 1e6
    return A_WEEK * (PHI if "fable" in r["model"] else 1) * (x + RHO * r["cr"] * c / 1e6)

hourly = defaultdict(float)                      # UTC hour -> % of week
for r in R.values():
    t = datetime.fromisoformat(r["t"].replace("Z", "+00:00")).replace(minute=0, second=0, microsecond=0)
    hourly[t] += pct(r)
start = min(hourly); end = max(hourly)
H = lambda t: hourly.get(t, 0.0)
RESET = datetime(2026, 9, 25, 1, tzinfo=timezone.utc)   # a weekly reset; weeks repeat every 7 days
weeks = []
w = RESET
while w - timedelta(days=7) > start + timedelta(days=14): w -= timedelta(days=7)   # need 14 days of history first
while w <= end + timedelta(hours=1): weeks.append(w); w += timedelta(days=7)

def used(a, b):  # % used in [a, b)
    s, t = 0.0, a
    while t < b: s += H(t); t += timedelta(hours=1)
    return s

def daily_rates(now, days, half_life):
    """Recency-weighted mean of the last `days` daily totals (24 h blocks ending now)."""
    tot, wsum = 0.0, 0.0
    for k in range(days):
        d = used(now - timedelta(hours=24 * (k + 1)), now - timedelta(hours=24 * k))
        wk = 0.5 ** (k / half_life)
        tot += wk * d; wsum += wk
    return tot / wsum

def hour_shape(now, days=14):
    """Share of a day's usage that falls in each UTC hour, over the last `days` days (smoothed)."""
    prof = [0.0] * 24
    for k in range(days * 24):
        t = now - timedelta(hours=k + 1); prof[t.hour] += H(t)
    s = sum(prof) or 1
    return [(p + s / 24 * 0.2) / (s * 1.2) for p in prof]   # 20 % flat floor: rhythms aren't exact

def M0(now, reset, so_far):     # current method: average pace since the week started
    el = max(0.25, (now - (reset - timedelta(days=7))).total_seconds() / 3600)
    return so_far + so_far / el * (reset - now).total_seconds() / 3600

def M1(now, reset, so_far, days=7, hl=3):
    return so_far + daily_rates(now, days, hl) / 24 * (reset - now).total_seconds() / 3600

def M2(now, reset, so_far, days=7, hl=3):
    daily, shape = daily_rates(now, days, hl), hour_shape(now)
    s, t = so_far, now
    while t < reset: s += daily * shape[t.hour]; t += timedelta(hours=1)
    return s

def M3(now, reset, so_far):     # same hours of the week in the previous 2 weeks, averaged
    s = so_far; t = now
    while t < reset:
        s += (H(t - timedelta(days=7)) + H(t - timedelta(days=14))) / 2; t += timedelta(hours=1)
    return s

methods = {"M0 avg since start": M0, "M1 recent daily rate": M1, "M2 rate + hour shape": M2, "M3 same hours past weeks": M3,
           "M2 hl=2 days=10": lambda n, r, s: M2(n, r, s, 10, 2), "M2 hl=5 days=14": lambda n, r, s: M2(n, r, s, 14, 5)}
err = defaultdict(list); by_day = defaultdict(lambda: defaultdict(list))
for reset in weeks:
    wstart = reset - timedelta(days=7); final = used(wstart, reset)
    if final < 3: continue
    for h in range(12, 168, 12):
        now = wstart + timedelta(hours=h); so_far = used(wstart, now)
        for name, f in methods.items():
            e = f(now, reset, so_far) - final
            err[name].append(e); by_day[name][h // 24].append(abs(e))
print(f"{len(weeks)} weeks, {len(err['M0 avg since start'])} forecasts each (every 12 h); errors in % of the week")
print(f"{'method':26s} {'MAE':>5s} {'median':>6s} {'bias':>6s} {'P90':>5s} | MAE by day of week 0..6")
for name, es in err.items():
    a = sorted(abs(e) for e in es)
    print(f"{name:26s} {st.mean(a):5.1f} {st.median(a):6.1f} {st.mean(es):+6.1f} {a[int(.9 * len(a))]:5.1f} | " +
          " ".join(f"{st.mean(by_day[name][d]):4.1f}" for d in range(7)))

# ---- round 2: burst-resistant variants
print("\nweek totals:", [f"{w.date()}: {used(w - timedelta(days=7), w):.0f}%" for w in weeks])
def daily_list(now, days):
    return [used(now - timedelta(hours=24 * (k + 1)), now - timedelta(hours=24 * k)) for k in range(days)]
def M5(now, reset, so_far):     # median day of the last 14
    return so_far + st.median(daily_list(now, 14)) / 24 * (reset - now).total_seconds() / 3600
def M6(now, reset, so_far):     # blend of M0 and the median-day rate
    return (M0(now, reset, so_far) + M5(now, reset, so_far)) / 2
def typical_week(now, n=4):     # mean of the last n complete 7-day blocks before now
    return st.mean(used(now - timedelta(days=7 * (k + 1)), now - timedelta(days=7 * k)) for k in range(n))
def M7(now, reset, so_far, n=4):
    """Shrinkage: the rest of the week uses the typical rate, weighted against this week's own pace
    by how much of the week has passed (early: mostly typical; late: mostly this week)."""
    el = (now - (reset - timedelta(days=7))).total_seconds() / 3600; left = (reset - now).total_seconds() / 3600
    own = so_far / max(el, 1); typ = typical_week(now, n) / 168; w = el / 168
    return so_far + (w * own + (1 - w) * typ) * left
def M8(now, reset, so_far):     # M7, but "typical" from the median of the last 21 days
    el = (now - (reset - timedelta(days=7))).total_seconds() / 3600; left = (reset - now).total_seconds() / 3600
    own = so_far / max(el, 1); typ = st.median(daily_list(now, 21)) / 24; w = el / 168
    return so_far + (w * own + (1 - w) * typ) * left
more = {"M5 median day (14)": M5, "M6 avg of M0+M5": M6, "M7 shrink to typical wk": M7, "M8 shrink to median day": M8,
        "M7 n=2": lambda a, b, c: M7(a, b, c, 2)}
err2 = defaultdict(list); by2 = defaultdict(lambda: defaultdict(list))
for reset in weeks:
    wstart = reset - timedelta(days=7); final = used(wstart, reset)
    if final < 3: continue
    for h in range(12, 168, 12):
        now = wstart + timedelta(hours=h); so_far = used(wstart, now)
        for name, f in {"M0 avg since start": M0, **more}.items():
            e = f(now, reset, so_far) - final
            err2[name].append(e); by2[name][h // 24].append(abs(e))
for name, es in err2.items():
    a = sorted(abs(e) for e in es)
    print(f"{name:26s} {st.mean(a):5.1f} {st.median(a):6.1f} {st.mean(es):+6.1f} {a[int(.9 * len(a))]:5.1f} | " +
          " ".join(f"{st.mean(by2[name][d]):4.1f}" for d in range(7)))

# ---- round 3: resample real past days -> a range and a chance of running out
import random
def simulate(now, reset, so_far, days=14, n=400, seed=1):
    """Fill the rest of the week with whole past days (the last `days` days), each starting at the
    same clock hour as now, so a day's rhythm and its bursts stay together."""
    rnd = random.Random(seed)
    left_h = int((reset - now).total_seconds() // 3600)
    blocks = [[H(now - timedelta(hours=24 * (k + 1) - i)) for i in range(24)] for k in range(days)]
    finals = []
    for _ in range(n):
        s = so_far; h = 0
        while h < left_h:
            b = rnd.choice(blocks); take = min(24, left_h - h); s += sum(b[:take]); h += take
        finals.append(s)
    finals.sort()
    q = lambda p: finals[min(len(finals) - 1, int(p * len(finals)))]
    return q(.1), q(.5), q(.9), sum(f >= 100 for f in finals) / len(finals)
for days in (7, 14, 21):
    es, cover, briers = [], 0, []
    byd = defaultdict(list)
    for reset in weeks:
        wstart = reset - timedelta(days=7); final = used(wstart, reset)
        if final < 3: continue
        for h in range(12, 168, 12):
            now = wstart + timedelta(hours=h); so_far = used(wstart, now)
            lo, mid, hi, p_out = simulate(now, reset, so_far, days)
            es.append(mid - final); cover += lo <= final <= hi; byd[h // 24].append(abs(mid - final))
            briers.append((p_out - (final >= 100)) ** 2)
    a = sorted(abs(e) for e in es)
    print(f"resample {days:2d} days: median-forecast MAE {st.mean(a):5.1f} median {st.median(a):4.1f} bias {st.mean(es):+5.1f} P90 {a[int(.9*len(a))]:5.1f} | "
          f"P10-P90 covers {100*cover/len(es):.0f}% (target 80) | run-out Brier {st.mean(briers):.3f} | by day " + " ".join(f"{st.mean(byd[d]):4.1f}" for d in range(7)))

# ---- round 4: multi-day blocks (bursts last days), longer history
def simulate_blocks(now, reset, so_far, days=28, block=72, n=400, seed=1):
    rnd = random.Random(seed)
    left_h = int((reset - now).total_seconds() // 3600)
    hist = [H(now - timedelta(hours=days * 24 - i)) for i in range(days * 24)]   # oldest first, ends at now
    # blocks start at the same clock hour as now (every 24 h), each `block` hours long
    starts = [s for s in range(0, days * 24 - block + 1, 24)]
    finals = []
    for _ in range(n):
        s = so_far; h = 0
        while h < left_h:
            st0 = rnd.choice(starts); take = min(block, left_h - h); s += sum(hist[st0:st0 + take]); h += take
        finals.append(s)
    finals.sort()
    q = lambda p: finals[min(len(finals) - 1, int(p * len(finals)))]
    return q(.1), q(.5), q(.9), sum(f >= 100 for f in finals) / len(finals)
for days, block in ((28, 24), (28, 72), (35, 72), (35, 120)):
    es, cover, briers, width = [], 0, [], []
    for reset in weeks:
        wstart = reset - timedelta(days=7); final = used(wstart, reset)
        if final < 3: continue
        for h in range(12, 168, 12):
            now = wstart + timedelta(hours=h); so_far = used(wstart, now)
            lo, mid, hi, p_out = simulate_blocks(now, reset, so_far, days, block)
            es.append(mid - final); cover += lo <= final <= hi; briers.append((p_out - (final >= 100)) ** 2); width.append(hi - lo)
    a = sorted(abs(e) for e in es)
    print(f"blocks {block:3d}h from {days} days: MAE {st.mean(a):5.1f} median {st.median(a):4.1f} bias {st.mean(es):+5.1f} | "
          f"P10-P90 covers {100*cover/len(es):.0f}% (width median {st.median(width):.0f}) | run-out Brier {st.mean(briers):.3f}")
