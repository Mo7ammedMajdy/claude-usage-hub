"""Independent re-read of every Claude Code request on this laptop -> reqs.json.
Written from scratch (not the collector's code): dedupe by requestId, keep raw token parts."""
import glob, json, os, sys
from datetime import datetime
out = {}
for f in glob.glob(os.path.expanduser("~/.claude/projects/**/*.jsonl"), recursive=True):
    with open(f, errors="ignore") as fh:
        for ln in fh:
            if '"usage"' not in ln: continue
            try: d = json.loads(ln)
            except Exception: continue
            m = d.get("message") or {}
            u = m.get("usage")
            if not u or d.get("type") != "assistant": continue
            model = m.get("model", "")
            if model.startswith("<"): continue
            rid = d.get("requestId") or d.get("uuid")
            cc = u.get("cache_creation") or {}
            its = u.get("iterations") or []
            rec = {"t": d["timestamp"], "model": model, "in": u.get("input_tokens", 0), "out": u.get("output_tokens", 0),
                   "cr": u.get("cache_read_input_tokens", 0), "cw": u.get("cache_creation_input_tokens", 0),
                   "c1h": cc.get("ephemeral_1h_input_tokens", 0), "iters": len(its), "side": bool(d.get("isSidechain")),
                   "speed": u.get("speed") or m.get("speed"), "file": os.path.basename(f)[:12]}
            prev = out.get(rid)
            # last line of a request carries the final output count
            if not prev or rec["out"] >= prev["out"]: out[rid] = rec
json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "reqs.json"), "w"))
from collections import Counter, defaultdict
agg = defaultdict(lambda: [0,0,0,0,0,0])
for r in out.values():
    if r["t"] < "2026-09-17": continue
    a = agg[r["model"]]; a[0]+=1; a[1]+=r["in"]; a[2]+=r["out"]; a[3]+=r["cr"]; a[4]+=r["cw"]; a[5]+=r["c1h"]
for k,v in sorted(agg.items(), key=lambda kv:-kv[1][0]): print(k, "calls",v[0],"in",v[1],"out",v[2],"cr",v[3],"cw",v[4],"c1h",v[5])
print("speeds", Counter(r["speed"] for r in out.values()))
print("multi-iteration", sum(1 for r in out.values() if r["iters"]>1))
