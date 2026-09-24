#!/usr/bin/env python3
"""Claude Code statusline: live context window, what this chat has used of the shared plan,
and the plan's limits.

Reads the statusline JSON on stdin and this session's transcript (incrementally: each render
only parses what was appended since the last one), plus three files claude-usage-sync keeps
fresh — the official limits, the hub's learned rates and how its last sync went. No network
calls, so it stays fast.

Wire it up in ~/.claude/settings.json:
    "statusLine": {"type": "command", "command": "/path/to/claude-statusline.py"}
and, for the one loud nudge when the context gets deep, as a UserPromptSubmit hook with --hook.
"""
import bisect, hashlib, json, os, re, sys, time, pathlib
from datetime import datetime, timedelta

HOME = pathlib.Path.home()
CACHE_DIR = pathlib.Path(os.environ.get("XDG_CACHE_HOME") or HOME / ".cache") / "claude-usage"
SCAN_DIR = CACHE_DIR / "statusline"
WARN, DANGER = 70, 85          # context %: amber, then red + a nudge to /compact
KEEP_S = 8 * 86400             # per-request records older than a week can't count toward anything
STATE_VERSION = 3              # per-transcript state format; 2 added "turns"/"busy", 3 final-line pricing (older state is re-read)
TURNS = 10                     # "msgs left" averages this chat's last 10 finished messages
SYNC_LAG = 15 * 60             # the collector syncs every 5 min at most: 15 min without one is a fault
WIDTH = 120                    # columns the whole line should fit in

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


def typed(r):
    """A message the person sent: not a tool result, hook text, task notification, compact
    summary or interrupt marker. Newer Claude Code labels the sender in `origin`."""
    if r.get("isMeta") or r.get("isSidechain") or r.get("isCompactSummary"):
        return False
    if isinstance(r.get("origin"), dict):
        return r["origin"].get("kind") == "human"
    c = (r.get("message") or {}).get("content")
    if isinstance(c, str):
        return not c.startswith("<")
    return any(isinstance(b, dict) and b.get("type") == "text" and not (b.get("text") or "").startswith("[Request interrupted")
               for b in c or [])


def scan(path):
    """Everything appended to one transcript since the last render, folded into a small state:
    {off, reqs: {requestId: [t, family, x, r]}, ctx, ctx_est, turns: [t of the last typed
    messages], busy: the newest turn is still running}. Kept per file under SCAN_DIR."""
    SCAN_DIR.mkdir(parents=True, exist_ok=True)
    cf = SCAN_DIR / (hashlib.sha1(str(path).encode()).hexdigest()[:16] + ".json")
    fresh = {"off": 0, "reqs": {}, "ctx": 0, "ctx_est": False, "turns": [], "busy": False,
             "pv": PRICE_VERSION, "v": STATE_VERSION}
    try:
        s = json.loads(cf.read_text())
        if s.get("pv") != PRICE_VERSION or s.get("v") != STATE_VERSION:  # older table or format: read it again
            s = fresh
    except Exception:
        s = fresh
    try:
        size = os.path.getsize(path)
        if size < s["off"]:                      # rewritten from scratch
            s = fresh
        # A first render of a long chat reads a big file: cap it at the last 64 MB (enough for any
        # window's requests); older requests can't count toward the session or week anyway.
        with open(path, "rb") as f:
            if size - s["off"] > 64 << 20:
                s["off"] = size - (64 << 20)
                f.seek(s["off"])
                f.readline()                     # skip the partial line we landed in
                s["off"] = f.tell()
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
        if r.get("type") == "user":
            if typed(r):
                s["turns"] = s["turns"][-TURNS:] + [ts(r.get("timestamp", "")) or time.time()]
                s["busy"] = True
            continue
        if r.get("type") != "assistant":
            continue
        msg = r.get("message") or {}
        u = msg.get("usage")
        if not u:
            continue
        rid = r.get("requestId") or r.get("uuid")
        # One request, many content-block lines: the last one carries the final output count, so
        # each line replaces the price (the first line undercounted streamed replies by ~8%).
        prev = s["reqs"].get(rid)
        x, cr = weight(msg.get("model", ""), u)
        s["reqs"][rid] = [prev[0] if prev else ts(r.get("timestamp", "")) or time.time(), family(msg.get("model", "")), x, cr]
        if not r.get("isSidechain"):
            s["ctx"] = u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
            s["ctx_est"] = False
            # A reply that stops for anything but a tool call ends the turn; until then the
            # newest turn's cost is still growing and would read as a cheap message.
            s["busy"] = msg.get("stop_reason") in (None, "tool_use", "pause_turn")
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
    """(context tokens, context is provisional, per-request records incl. this chat's subagents,
    the main transcript's state)."""
    main = scan(transcript)
    reqs = dict(main["reqs"])
    sub = pathlib.Path(transcript).with_suffix("") / "subagents"
    if sub.is_dir():
        for f in sub.rglob("*.jsonl"):          # workflow agents sit one level deeper
            reqs.update(scan(f)["reqs"])
    return main["ctx"], main["ctx_est"], reqs, main


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
        start = lambda w, hours: (ts(w.get("resets_exact") or w["resets_at"]) - hours * 3600) if w.get("resets_at") else None
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


def per_message(state, reqs, rate):
    """% of the session one of this chat's recent messages cost, priced like used().

    Counted per message the person typed, not per API call: one message sets off a whole tool
    loop (and maybe subagents), and messages are what someone can decide to send or not. A
    message's cost is everything this chat logged from it until the next one, subagents
    included, averaged over the last TURNS finished messages. None when there is nothing to go on.
    """
    if not rate or rate.get("a") is None or not state.get("turns"):
        return None
    a, b, m = rate["a"], rate.get("b", rate["a"]), rate.get("m") or {}
    starts = state["turns"]
    cost = [0.0] * len(starts)
    for t, fam, x, r in reqs.values():
        if t >= starts[0]:
            cost[bisect.bisect_right(starts, t) - 1] += m.get(fam, 1) * (a * x + b * r)
    old = time.time() - KEEP_S     # requests that far back were dropped: those turns would look free
    done = [c for c, t in zip(cost[:-1] if state.get("busy") else cost, starts) if t >= old][-TURNS:]
    return sum(done) / len(done) if done else None


def sync_warning():
    """How long the collector hasn't reached the hub, once that is past SYNC_LAG. From the
    status file it writes after every try; older collectors write none, so say nothing then."""
    try:
        d = json.loads((CACHE_DIR / "sync.json").read_text())
    except Exception:
        return ""
    last = ts(d.get("last_ok") or "")
    if last is None:               # failing and never got through: for how long is unknown
        return f"{AMBER}⚠ not syncing{RESET}" if d.get("ok") is False else ""
    lag = time.time() - last
    if lag < SYNC_LAG:             # also covers a dead daemon: last_ok just stops moving
        return ""
    m = int(lag // 60)
    dur = f"{m}m" if m < 60 else f"{m // 60}h{m % 60:02d}m" if m < 1440 else f"{m // 1440}d"
    return f"{AMBER}⚠ not syncing {dur}{RESET}"


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
    ctx, *_ = session(inp.get("transcript_path") or "")
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
    # "Opus 5.5 (1M context)" -> "Opus 5.5 (1M)": the whole line has to fit ~WIDTH columns.
    name = (model.get("display_name") or model.get("id") or "claude").replace(" context)", ")")
    cwd = inp.get("workspace", {}).get("current_dir") or inp.get("cwd") or ""
    short = cwd.replace(str(HOME), "~")

    ctx, provisional, reqs, state = session(inp.get("transcript_path") or "")
    pct = round(100 * ctx / window(inp, ctx))
    colour = RED if pct >= DANGER else AMBER if pct >= WARN else GREY
    parts = [f"{BLUE}{short}{RESET}", f"{GREY}{name}{RESET}",
             f"{colour}ctx {'~' if provisional else ''}{pct}%{RESET}"]
    if pct >= DANGER:
        parts[-1] += f" {RED}→ /compact{RESET}"

    five, week, stale, five_start, week_start = plan()
    rt = rates()
    mine5, mineW = used(reqs, five_start, rt.get("five")), used(reqs, week_start, rt.get("week"))
    # This chat's share of each limit, e.g. "(chat ≈3.2)"; whole points from 10 up (the rate isn't finer).
    share = lambda v: "" if v is None else f" {DIM}(chat {'<0.1' if v < 0.1 else f'≈{v:.1f}' if v < 10 else f'≈{v:.0f}'}){RESET}"
    if five is not None:
        pc = RED if five >= 85 else AMBER if five >= 70 else GREY
        # Time until the session resets, e.g. "↻1h15m" (from the window's start + 5 h).
        left = None if five_start is None else five_start + 5 * 3600 - time.time()
        reset = "" if left is None or left <= 0 else f" {DIM}↻{int(left // 3600)}h{int(left % 3600 // 60):02d}m{RESET}" if left >= 3600 else f" {DIM}↻{int(left // 60)}m{RESET}"
        parts.append(f"{pc}session {'~' if stale else ''}{five}%{RESET}{reset}{share(mine5)}")
        # How many more messages like this chat's recent ones fit in what the session has left,
        # if nothing else used it. Rounded down: one that doesn't fully fit doesn't count.
        per = per_message(state, reqs, rt.get("five"))
        n = int((100 - five) / per) if per and five < 100 else None
        if n is not None and n < 1000:   # past that it says nothing useful and costs width
            mc = RED if n < 3 else AMBER if n < 10 else GREY
            parts.append(f"{mc}{'<1 msg' if n < 1 else '~1 msg' if n == 1 else f'~{n} msgs'} left{RESET}")
    if week is not None:
        wc = RED if week >= 90 else AMBER if week >= 75 else GREY
        parts.append(f"{wc}week {week}%{RESET}{share(mineW)}")
        wk = len(parts) - 1
    warn = sync_warning()            # last, and only when something is wrong
    if warn:
        parts.append(warn)

    # Too wide: give way in order of least use — the full path (it rarely changes), then this
    # chat's share of the week (the session's share is the one that moves).
    wide = lambda: len(re.sub(r"\x1b\[[0-9;]*m", "", " · ".join(parts))) > WIDTH
    if wide():
        parts[0] = f"{BLUE}{pathlib.PurePath(short).name or short}{RESET}"
    if wide() and week is not None:
        parts[wk] = f"{wc}week {week}%{RESET}"
    print(f" {DIM}·{RESET} ".join(parts))


if __name__ == "__main__":
    main()
