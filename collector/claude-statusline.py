#!/usr/bin/env python3
"""Claude Code statusline: live context window, what this chat has used of the shared plan,
and the plan's limits.

Reads the statusline JSON on stdin and this session's transcript (incrementally: each render
only parses what was appended since the last one), plus two files claude-usage-sync keeps
fresh — the official limits and the hub's learned rates. No network calls, so it stays fast.

Wire it up in ~/.claude/settings.json:
    "statusLine": {"type": "command", "command": "/path/to/claude-statusline.py"}
and, for the one loud nudge when the context gets deep, as a UserPromptSubmit hook with --hook.
"""
import hashlib, json, os, sys, time, pathlib
from datetime import datetime, timedelta

HOME = pathlib.Path.home()
CACHE_DIR = pathlib.Path(os.environ.get("XDG_CACHE_HOME") or HOME / ".cache") / "claude-usage"
SCAN_DIR = CACHE_DIR / "statusline"
WARN, DANGER = 70, 85          # context %: amber, then red + a nudge to /compact
KEEP_S = 8 * 86400             # per-request records older than a week can't count toward anything

# API $ per 1M tokens: (input, output, cache read). Same table as claude-usage-sync (see there).
PRICE_VERSION = 2
PRICES = [
    ("claude-fable-5-1", (10, 50, 0.25)), ("claude-mythos-5-1", (10, 50, 0.25)),
    ("claude-fable", (10, 50, 1.0)), ("claude-mythos", (10, 50, 1.0)),
    ("claude-opus-5-5", (4, 20, 0.2)),
    ("claude-opus-4-1", (15, 75, 1.5)), ("claude-opus-4-2025", (15, 75, 1.5)),
    ("claude-opus", (5, 25, 0.5)),
    ("claude-sonnet-5", (2, 10, 0.2)), ("claude-sonnet", (3, 15, 0.3)),
    ("claude-3-5-haiku", (0.8, 4, 0.08)), ("claude-haiku", (1, 5, 0.1)),
]



DIM, RESET = "\x1b[2m", "\x1b[0m"
GREY, AMBER, RED, BLUE = "\x1b[38;5;245m", "\x1b[38;5;179m", "\x1b[38;5;174m", "\x1b[38;5;110m"


def family(m):
    return ("fable" if ("fable" in m or "mythos" in m) else "opus" if "opus" in m else
            "sonnet" if "sonnet" in m else "haiku" if "haiku" in m else "other")


def weight(model, u, speed=None):
    """Price-weighted (x, r): x = input+output+cache writes, r = cache reads. As the collector."""
    inp, out, cr = next((p for pre, p in PRICES if (model or "").startswith(pre)), (5, 25, 0.5))
    if (speed or u.get("speed")) == "fast":
        inp, out, cr = inp * 2, out * 2, cr * 2
    cc = u.get("cache_creation") or {}
    c1h = cc.get("ephemeral_1h_input_tokens", 0)
    c5m = cc.get("ephemeral_5m_input_tokens", u.get("cache_creation_input_tokens", 0) - c1h)
    x = (u.get("input_tokens", 0) * inp + u.get("output_tokens", 0) * out + c5m * inp * 1.25 + c1h * inp * 2) / 1e6
    return x, u.get("cache_read_input_tokens", 0) * cr / 1e6


def ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def scan(path):
    """Everything appended to one transcript since the last render, folded into a small state:
    {off, reqs: {requestId: [t, family, x, r]}, ctx, ctx_est}. Kept per file under SCAN_DIR."""
    SCAN_DIR.mkdir(parents=True, exist_ok=True)
    cf = SCAN_DIR / (hashlib.sha1(str(path).encode()).hexdigest()[:16] + ".json")
    fresh = {"off": 0, "reqs": {}, "ctx": 0, "ctx_est": False, "pv": PRICE_VERSION}
    try:
        s = json.loads(cf.read_text())
        if s.get("pv") != PRICE_VERSION:         # priced with an older table: read it again
            s = fresh
    except Exception:
        s = fresh
    try:
        size = os.path.getsize(path)
        if size < s["off"]:                      # rewritten from scratch
            s = fresh
        with open(path, "rb") as f:
            f.seek(s["off"])
            data = f.read()
    except Exception:
        return s
    end = data.rfind(b"\n") + 1                  # only complete lines; a half-written one waits
    for ln in data[:end].split(b"\n"):
        if not ln.strip():
            continue
        try:
            r = json.loads(ln)
        except Exception:
            continue
        if r.get("type") == "system" and r.get("subtype") == "compact_boundary":
            # Until the next response, the newest usage record is the compaction call itself,
            # which read the whole pre-compact context. The boundary knows the size after.
            s["ctx"] = (r.get("compactMetadata") or {}).get("postTokens") or 0
            s["ctx_est"] = True
            continue
        if r.get("type") != "assistant":
            continue
        msg = r.get("message") or {}
        u = msg.get("usage")
        if not u:
            continue
        rid = r.get("requestId") or r.get("uuid")
        if rid not in s["reqs"]:                 # one request, many content-block lines
            x, cr = weight(msg.get("model", ""), u)
            s["reqs"][rid] = [ts(r.get("timestamp", "")) or time.time(), family(msg.get("model", "")), x, cr]
        if not r.get("isSidechain"):
            s["ctx"] = u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
            s["ctx_est"] = False
    s["off"] += end
    cutoff = time.time() - KEEP_S
    s["reqs"] = {k: v for k, v in s["reqs"].items() if v[0] >= cutoff}
    try:
        tmp = cf.with_suffix(".tmp")
        tmp.write_text(json.dumps(s))
        tmp.replace(cf)
    except Exception:
        pass
    return s


def session(transcript):
    """(context tokens, context is provisional, per-request records incl. this chat's subagents)."""
    main = scan(transcript)
    reqs = dict(main["reqs"])
    sub = pathlib.Path(transcript).with_suffix("") / "subagents"
    if sub.is_dir():
        for f in sub.glob("*.jsonl"):
            reqs.update(scan(f)["reqs"])
    return main["ctx"], main["ctx_est"], reqs


def window(inp, ctx):
    """Usable context in tokens.

    The 1M variant is only visible in the model id, which the statusline gets but a hook does
    not — and the transcript records the model without the "[1m]" suffix. So fall back to the
    configured default model, and to the context itself: past 200k it can only be the big one.
    """
    ids = [(inp.get("model") or {}).get("id") or ""]
    try:
        ids.append(json.loads((HOME / ".claude/settings.json").read_text()).get("model") or "")
    except Exception:
        pass
    if any("1m" in i.lower() for i in ids) or ctx > 200_000 or inp.get("exceeds_200k_tokens"):
        return 1_000_000
    return 200_000


def plan():
    """Official limits the sync daemon cached: (session%, week%, stale, window starts)."""
    try:
        d = json.loads((CACHE_DIR / "official.json").read_text())
        stale = time.time() - os.path.getmtime(CACHE_DIR / "official.json") > 900
        five, week = d.get("five_hour") or {}, d.get("seven_day") or {}
        start = lambda w, hours: (ts(w["resets_at"]) - hours * 3600) if w.get("resets_at") else None
        num = lambda v: None if v is None else round(v)
        return num(five.get("pct")), num(week.get("pct")), stale, start(five, 5), start(week, 168)
    except Exception:
        return None, None, True, None, None


def used(reqs, since, rate):
    """% of a limit this chat's requests since `since` should account for, from the hub's fit."""
    if not rate or since is None or rate.get("a") is None:
        return None
    a, b, m = rate["a"], rate.get("b", rate["a"]), rate.get("m") or {}
    return sum(m.get(fam, 1) * (a * x + b * r) for t, fam, x, r in reqs.values() if t >= since)


def rates():
    try:
        return json.loads((CACHE_DIR / "rate.json").read_text())
    except Exception:
        return {}


def person():
    """Whose laptop this is, from the sync daemon's config; used to address the nudge."""
    try:
        for line in (HOME / ".config/claude-usage-sync/env").read_text().splitlines():
            if line.startswith("HUB_PERSON=") and line[11:].strip():
                return line[11:].strip()
    except Exception:
        pass
    return "the user"


def hook(inp):
    """UserPromptSubmit mode: say something only when the context is genuinely deep.

    The statusline already carries the number all the time; this exists so a long session
    gets one loud nudge instead of quietly burning a window on re-read context.
    """
    ctx, _, _ = session(inp.get("transcript_path") or "")
    pct = round(100 * ctx / window(inp, ctx))
    if pct < DANGER:
        return
    five, week, *_ = plan()
    limits = f" The shared plan is at {five}% of this session and {week}% of the week." if five is not None else ""
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": (
            f"Context window is {pct}% full ({ctx:,} tokens).{limits} Every further message re-reads "
            f"all of it. Tell {person()}, in one line, to run /compact — then carry on with the request."),
    }}))


def main():
    try:
        inp = json.load(sys.stdin)
    except Exception:
        inp = {}
    if "--hook" in sys.argv:
        return hook(inp)

    model = inp.get("model") or {}
    name = model.get("display_name") or model.get("id") or "claude"
    cwd = inp.get("workspace", {}).get("current_dir") or inp.get("cwd") or ""
    short = cwd.replace(str(HOME), "~")

    ctx, provisional, reqs = session(inp.get("transcript_path") or "")
    pct = round(100 * ctx / window(inp, ctx))
    colour = RED if pct >= DANGER else AMBER if pct >= WARN else GREY
    parts = [f"{BLUE}{short}{RESET}", f"{GREY}{name}{RESET}",
             f"{colour}ctx {'~' if provisional else ''}{pct}%{RESET}"]
    if pct >= DANGER:
        parts[-1] += f" {RED}→ /compact{RESET}"

    five, week, stale, five_start, week_start = plan()
    rt = rates()
    mine5, mineW = used(reqs, five_start, rt.get("five")), used(reqs, week_start, rt.get("week"))
    share = lambda v: "" if v is None else f" {DIM}(this chat ≈{v:.1f}){RESET}" if v >= 0.1 else f" {DIM}(this chat <0.1){RESET}"
    if five is not None:
        pc = RED if five >= 85 else AMBER if five >= 70 else GREY
        parts.append(f"{pc}session {'~' if stale else ''}{five}%{RESET}{share(mine5)}")
    if week is not None:
        wc = RED if week >= 90 else AMBER if week >= 75 else GREY
        parts.append(f"{wc}week {week}%{RESET}{share(mineW)}")

    print(f" {DIM}·{RESET} ".join(parts))


if __name__ == "__main__":
    main()
