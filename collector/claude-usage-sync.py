#!/usr/bin/env python3
"""Push this device's Claude usage to the shared dashboard.

Reads the Claude Code / Agent SDK transcripts under ~/.claude/projects (incrementally:
each file is tailed from where it was last read) and the official limits from
Anthropic's OAuth usage endpoint (the data behind /usage). Stdlib only.
Config: ~/.config/claude-usage-sync/env (HUB_URL, HUB_KEY, HUB_DEVICE, HUB_PERSON,
optional HUB_CLAUDE_DIRS).

  claude-usage-sync            sync once
  claude-usage-sync --daemon   stay running: sync every 5 min (every 2 min while this
                               laptop is using Claude), within ~60 s of a dashboard
                               Refresh, and read the official % about once a minute
                               while busy (these readings are what the hub calibrates
                               its estimates on)
"""
import glob, hashlib, json, os, re, signal, socket, sys, time, urllib.error, urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path.home()
CONF = HOME / ".config/claude-usage-sync/env"
SYNC_EVERY, POLL_EVERY, SAMPLE_EVERY = 300, 30, 60
BUSY_SYNC_EVERY = 120    # while Claude is in use here, the dashboard hears about it this often
UPDATE_EVERY = 6 * 3600
REFRESH_POLL = 60        # how often to check for a dashboard Refresh (each check is a Redis read)
EPOCH = datetime(2000, 1, 1, tzinfo=timezone.utc)
# Context-size buckets (tokens in the prompt) for the cost-vs-context breakdown.
CTX_BUCKETS = [0, 25_000, 50_000, 100_000, 200_000, 400_000, 700_000, 10**9]


def load_conf():
    conf = {}
    if CONF.exists():
        for line in CONF.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                conf[k.strip()] = v.strip().strip('"')
    conf.update({k: v for k, v in os.environ.items() if k.startswith("HUB_")})
    return conf


def claude_dirs(conf):
    """Claude config dirs to read: HUB_CLAUDE_DIRS (colon-separated) if set, else
    $CLAUDE_CONFIG_DIR, else ~/.claude."""
    raw = conf.get("HUB_CLAUDE_DIRS") or os.environ.get("CLAUDE_CONFIG_DIR") or str(HOME / ".claude")
    return [Path(os.path.expanduser(p)) for p in raw.split(":") if p.strip()]


# API $ per 1M tokens: (input, output, cache read), from platform.claude.com/docs/en/about-claude/pricing
# (checked 2026-09-24). Cache writes are 1.25x input (5m) / 2x input (1h) for every model; cache
# reads are 0.1x input except Fable/Mythos 5.1 (0.025x) and Opus 5.5 (0.05x). Fast mode doubles
# input and output. Order matters: the first matching prefix wins. Only relative weights matter —
# the hub learns the real %-of-limit per unit — but they have to be right *relative to each other*,
# or a shift in the model mix looks like a change in the rate. PRICE_VERSION marks the table the
# readings were priced with; bump it when the table changes.
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


def weight(model, u, speed=None):
    """Price-weighted usage split into (x, r): x = input+output+cache writes, r = cache reads."""
    inp, out, cr = next((p for pre, p in PRICES if (model or "").startswith(pre)), (5, 25, 0.5))
    if (speed or u.get("speed")) == "fast":
        inp, out, cr = inp * 2, out * 2, cr * 2
    cc = u.get("cache_creation") or {}
    c1h = cc.get("ephemeral_1h_input_tokens", 0)
    c5m = cc.get("ephemeral_5m_input_tokens", u.get("cache_creation_input_tokens", 0) - c1h)
    x = (u.get("input_tokens", 0) * inp + u.get("output_tokens", 0) * out + c5m * inp * 1.25 + c1h * inp * 2) / 1e6
    return x, u.get("cache_read_input_tokens", 0) * cr / 1e6


def family(m):
    return ("fable" if ("fable" in m or "mythos" in m) else "opus" if "opus" in m else
            "sonnet" if "sonnet" in m else "haiku" if "haiku" in m else "other")


CACHE = Path(os.environ.get("XDG_CACHE_HOME") or HOME / ".cache") / "claude-usage" / "official.json"

# ---------------------------------------------------------------- claude.ai chats
# Usage from claude.ai itself never reaches these logs, which is most of what the hub has to
# guess at. The Claude Usage Tracker extension (lugia19) already works it out per conversation
# while you browse, and keeps it in chrome.storage.local — a LevelDB under the browser profile.
# Reading that file is purely local: no requests are made to anything.
EXT_STORES = ["Local Extension Settings"]
BROWSER_DIRS = ["chromium", "google-chrome", "microsoft-edge", "BraveSoftware/Brave-Browser",
                "vivaldi", "opera"]


def ext_stores():
    """Every extension storage directory that looks like it holds a conversation cache."""
    roots = [HOME / ".config" / b for b in BROWSER_DIRS]
    roots += [HOME / ".var/app" / a / "config" / b for a in
              ("com.google.Chrome", "org.chromium.Chromium", "com.brave.Browser") for b in BROWSER_DIRS]
    out = []
    for root in roots:
        for store in EXT_STORES:
            out += [p for p in glob.glob(str(root / "*" / store / "*")) if os.path.isdir(p)]
    return out


def ext_value(buf, key):
    """Last written value for `key` in a raw LevelDB dump, or None.

    Each StoredMap is one key holding a JSON array of [id, {expires, value}] pairs; LevelDB
    puts a type byte between the key name and the JSON, so skip forward to the first bracket.
    """
    for m in list(re.finditer(re.escape(key), buf))[::-1]:
        i = m.end()
        while i < len(buf) and buf[i] not in "[{" and i - m.end() < 6:
            i += 1
        if i >= len(buf) or buf[i] not in "[{":
            continue
        depth, j, instr, esc = 0, i, False, False
        while j < len(buf):
            c = buf[j]
            if instr:
                esc = (c == "\\") and not esc
                if c == '"' and not esc:
                    instr = False
            elif c == '"':
                instr = True
            elif c in "[{":
                depth += 1
            elif c in "]}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(buf[i:j + 1])
                    except Exception:
                        break
            j += 1
    return None


def chats():
    """Per-conversation size and cost for claude.ai, from the tracker extension's cache.

    Only the numbers travel: no titles, no message text, no tool settings.
    """
    out = {}
    for store in ext_stores():
        buf = b""
        try:
            for f in sorted(Path(store).iterdir()):
                if f.suffix in (".log", ".ldb"):
                    buf += f.read_bytes()
        except Exception:
            continue
        if b"conversationCache" not in buf:
            continue
        pairs = ext_value(buf.decode("utf-8", "replace"), "conversationCache") or []
        for entry in pairs:
            if not (isinstance(entry, list) and len(entry) == 2):
                continue
            cid, wrapped = entry
            v = wrapped.get("value") if isinstance(wrapped, dict) and "value" in wrapped else wrapped
            if not isinstance(v, dict) or not v.get("length"):
                continue
            ts = v.get("lastMessageTimestamp")
            out[cid[:8]] = {
                "id": cid[:8], "len": v.get("length"), "cost": v.get("cost"),
                "model": v.get("modelVersion") or v.get("model"), "effort": v.get("effortLabel"),
                "est": bool(v.get("lengthIsEstimate")), "in_project": bool(v.get("projectUuid")),
                "t": datetime.fromtimestamp(ts / 1000, timezone.utc).isoformat() if ts else None,
            }
    return sorted(out.values(), key=lambda c: c["t"] or "", reverse=True)[:60]


def cache_official(out):
    """Leave the latest official reading where the statusline can find it without a network call."""
    try:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE.with_suffix(".tmp")
        tmp.write_text(json.dumps({**out, "read_at": datetime.now(timezone.utc).isoformat()}))
        tmp.replace(CACHE)
    except Exception:
        pass


def cache_rate(rate):
    """The hub's learned %-per-API-$ rates, for the statusline to price a session locally."""
    try:
        tmp = CACHE.with_name("rate.tmp")
        tmp.write_text(json.dumps(rate))
        tmp.replace(CACHE.with_name("rate.json"))
    except Exception:
        pass


def account(dirs):
    """A short hash of the Claude account this laptop is logged into — enough for the hub to
    check that every laptop is on the same account, without sending who it is."""
    for d in dirs + [HOME]:
        for f in (d / ".claude.json", d.parent / ".claude.json"):
            try:
                a = json.loads(f.read_text()).get("oauthAccount") or {}
                if a.get("organizationUuid"):
                    return hashlib.sha256(a["organizationUuid"].encode()).hexdigest()[:10]
            except Exception:
                pass
    return None


def official(dirs):
    """The official limits, or None — and in that case `official.why` says what went wrong,
    so the hub can show it instead of a laptop that just silently never reads the %."""
    official.why = None
    if time.time() < official.until:
        # Anthropic asked us to slow down: don't ask again until it said we may.
        official.why = f"rate limited by Anthropic, retrying in {int(official.until - time.time())} s"
        return None
    try:
        creds = next((json.loads((d / ".credentials.json").read_text())
                      for d in dirs if (d / ".credentials.json").exists()), None)
        tok = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or ((creds or {}).get("claudeAiOauth") or {}).get("accessToken")
        if not tok:
            official.why = "no Claude Code login found (~/.claude/.credentials.json)"
            return None
        exp = ((creds or {}).get("claudeAiOauth") or {}).get("expiresAt")
        if exp and exp / 1000 < time.time() and not os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
            # Claude Code renews it the next time it runs; until then Anthropic answers 401.
            official.why = "login token expired " + datetime.fromtimestamp(exp / 1000, timezone.utc).isoformat(timespec="minutes") + \
                           " (Claude Code renews it when next used)"
            return None
        req = urllib.request.Request("https://api.anthropic.com/api/oauth/usage", headers={
            "Authorization": f"Bearer {tok}", "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "claude-code/usage-sync"})
        d = json.load(urllib.request.urlopen(req, timeout=10))
        minute = lambda r: r and datetime.fromisoformat(r).replace(second=0, microsecond=0).isoformat()
        # For display only: Anthropic sends e.g. 00:59:59.9 for a 01:00 reset, which the
        # truncated window id shows as 00:59. Round to the nearest minute instead.
        exact = lambda r: r and (datetime.fromisoformat(r) + timedelta(seconds=30)).replace(second=0, microsecond=0).isoformat()

        sev = {l.get("kind"): l.get("severity") for l in d.get("limits") or []}

        def pick(k, kind):  # resets_at rounded to the minute so devices agree on the window id
            return d.get(k) and {"pct": d[k].get("utilization"), "resets_at": minute(d[k].get("resets_at")),
                                 "resets_exact": exact(d[k].get("resets_at")),
                                 "severity": sev.get(kind)}
        scoped = [{"name": (l.get("scope") or {}).get("model", {}).get("display_name") or l["kind"],
                   "pct": l.get("percent"), "resets_at": minute(l.get("resets_at")),
                   "resets_exact": exact(l.get("resets_at")), "severity": l.get("severity")}
                  for l in d.get("limits") or [] if l.get("kind") == "weekly_scoped"]
        bd = d.get("seven_day_breakdown") or {}
        out = {"five_hour": pick("five_hour", "session"), "seven_day": pick("seven_day", "weekly_all"), "scoped": scoped,
               "breakdown": [{"key": r["key"], "name": r["display_name"], "percent": r["percent"]}
                             for r in bd.get("rows") or []],
               "breakdown_as_of": bd.get("as_of"), "plan": ((creds or {}).get("claudeAiOauth") or {}).get("rateLimitTier")}
        cache_official(out)
        return out
    except urllib.error.HTTPError as e:
        if e.code == 429:
            try:
                wait = int(e.headers.get("Retry-After") or 0)
            except ValueError:
                wait = 0
            official.until = time.time() + min(3600, max(wait, 300))
        official.why = f"Anthropic answered HTTP {e.code}" + (" (login token rejected)" if e.code in (401, 403) else
                                                             " (rate limited)" if e.code == 429 else "")
    except Exception as e:  # offline, etc. — the other laptop may cover it
        official.why = f"couldn't reach Anthropic: {type(e).__name__}: {str(e)[:120]}"
    print(f"official usage unavailable: {official.why}", file=sys.stderr, flush=True)
    return None


official.why = None
official.until = 0.0     # no official reads before this time (set by a 429)


def self_update(conf):
    """Keep this script (and the statusline next to it) in step with the hub, so a fix reaches
    every laptop without anyone re-running the installer. Same source the installer used; a
    download that doesn't compile is ignored. Returns True if this script was replaced."""
    base = conf["HUB_URL"].rstrip("/") + "/collector/"
    changed = False
    for name, dest in (("claude-statusline.py", HOME / ".local/bin/claude-statusline"),
                       ("claude-usage-sync.py", Path(os.path.abspath(__file__)))):
        try:
            if name == "claude-statusline.py" and not dest.exists():
                continue              # only update what was installed
            new = urllib.request.urlopen(base + name, timeout=30).read()
            if new == dest.read_bytes() or b"def main()" not in new:
                continue
            compile(new, str(dest), "exec")
            tmp = dest.with_name(dest.name + ".new")
            tmp.write_bytes(new); tmp.chmod(0o755); tmp.replace(dest)
            print(f"updated {dest.name} from the hub", flush=True)
            changed |= name == "claude-usage-sync.py"
        except Exception as e:
            print(f"update check for {name} failed: {e}", file=sys.stderr, flush=True)
    return changed


NOTIFY_AT = {"five_hour": (80, 95), "seven_day": (90, 97)}
NOTIFIED = CACHE.with_name("notified.json")


def notify(conf, off):
    """A desktop notification when the shared limits cross a threshold, once per window and
    level. The account is shared, so whoever is at a laptop gets the heads-up, whoever burned it.
    HUB_NOTIFY=0 in the config turns it off."""
    if conf.get("HUB_NOTIFY", "1") == "0" or not off or off.get("from_hub"):
        return
    import shutil, subprocess
    if not shutil.which("notify-send"):
        return
    try:
        seen = json.loads(NOTIFIED.read_text())
    except Exception:
        seen = {}
    names = {"five_hour": "session", "seven_day": "week"}
    changed = False
    for key, levels in NOTIFY_AT.items():
        lim = off.get(key) or {}
        pct, win = lim.get("pct"), lim.get("resets_at")
        if pct is None or not win:
            continue
        hit = max((l for l in levels if pct >= l), default=None)
        if hit is None or seen.get(key, {}).get(win, 0) >= hit:
            continue
        at = datetime.fromisoformat(lim.get("resets_exact") or win).astimezone()
        when = at.strftime("%H:%M") if key == "five_hour" else at.strftime("%a %H:%M")
        try:
            subprocess.Popen(["notify-send", "-a", "Claude usage", "-u", "critical" if hit == levels[-1] else "normal",
                              f"Claude {names[key]} at {pct:.0f}%", f"Shared limit. Resets {when}."],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            continue
        seen[key] = {win: hit}          # only the current window matters
        changed = True
    if changed:
        try:
            NOTIFIED.write_text(json.dumps(seen))
        except Exception:
            pass


def hub_windows(conf):
    """When this laptop can't read the official limits, the hub still knows the current
    windows from the other laptops. Readings taken against those windows carry no % but still
    put this laptop's logged usage on the timeline the fit uses."""
    try:
        o = post(conf, "/api/summary").get("official") or {}
        five, week = o.get("five") or {}, o.get("week") or {}
        if not five.get("resets_at") or datetime.fromisoformat(five["resets_at"]) <= datetime.now(timezone.utc):
            return None      # the hub's newest window has already ended: no better than guessing
        blank = lambda w: w.get("resets_at") and {"pct": None, "resets_at": w["resets_at"], "resets_exact": w.get("resets_exact")}
        return {"five_hour": blank(five), "seven_day": blank(week), "from_hub": True,
                "scoped": [{**blank(x), "name": x.get("name")} for x in o.get("scoped") or [] if x.get("resets_at")]}
    except Exception as e:
        print(f"hub windows unavailable: {e}", file=sys.stderr, flush=True)
        return None


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def is_prompt(d):
    """A message the person typed (not a tool result or injected meta text)."""
    if d.get("type") != "user" or d.get("isMeta") or d.get("isSidechain"):
        return False
    c = (d.get("message") or {}).get("content")
    if isinstance(c, str):
        return not c.startswith("<")
    return any(isinstance(b, dict) and b.get("type") == "text" for b in c or [])


SET_MODEL = re.compile(r"Set model to `([^`]+)`")


class LogIndex:
    """Everything in the transcripts, kept in memory and updated by tailing files."""

    def __init__(self, dirs):
        self.dirs = dirs
        self.files = {}        # path -> [offset, partial_line]
        self.reqs = {}         # requestId -> request record (last line per request wins)
        self.prompts = []      # (t, sessionId)
        self.compactions = []  # dict(t, sid, trigger, pre, post)
        self.switches = []     # (t, sid, model label) from /model
        self.titles = {}       # sid -> title
        self.agents = {}       # agentId -> meta (type, description, parent, depth)
        self.last_new = EPOCH  # newest request time seen

    def _files(self):
        return {f for d in self.dirs for f in glob.glob(str(d / "projects/**/*.jsonl"), recursive=True)}

    def update(self):
        """Read whatever was appended since last time. Returns the number of new requests."""
        new = 0
        for f in self._files():
            try:
                size = os.path.getsize(f)
            except OSError:
                continue
            off, part = self.files.get(f, [0, b""])
            if size < off:  # truncated or replaced: read again from the start
                off, part = 0, b""
            if size == off:
                self.files[f] = [off, part]
                continue
            agent = Path(f).stem[6:] if Path(f).stem.startswith("agent-") else None
            if agent and agent not in self.agents:
                try:
                    m = json.loads(Path(f).with_suffix(".meta.json").read_text())
                    self.agents[agent] = {"type": m.get("agentType"), "desc": m.get("description"),
                                          "parent": m.get("parentAgentId"), "depth": m.get("spawnDepth")}
                except (OSError, ValueError):
                    self.agents[agent] = {}
            # In blocks, so the first scan of a big log doesn't hold the whole file in memory
            # (it used to peak at ~700 MB on a laptop with a long history).
            with open(f, "rb") as fh:
                fh.seek(off)
                left = size - off
                while left > 0:
                    block = fh.read(min(left, 8 << 20))
                    if not block:
                        break
                    left -= len(block)
                    lines = (part + block).split(b"\n")
                    part = lines.pop()  # incomplete last line: keep for the next block / next time
                    for raw in lines:
                        new += self._line(raw, agent)
            self.files[f] = [size, part]
        return new

    def _line(self, raw, agent):
        s = raw.decode("utf-8", "ignore")
        if '"usage"' not in s and '"type":"user"' not in s and "compact_boundary" not in s and "ai-title" not in s:
            return 0
        try:
            d = json.loads(s)
        except ValueError:
            return 0
        typ, sid = d.get("type"), d.get("sessionId")
        if typ == "ai-title":
            self.titles[sid] = d.get("aiTitle")
            return 0
        t = d.get("timestamp")
        if not t:
            return 0
        t = ts(t)
        if typ == "system" and d.get("subtype") == "compact_boundary":
            m = d.get("compactMetadata") or {}
            self.compactions.append({"t": t, "sid": sid, "trigger": m.get("trigger"),
                                     "pre": m.get("preTokens"), "post": m.get("postTokens")})
            return 0
        m = d.get("message") or {}
        u = m.get("usage")
        if u and not m.get("model", "").startswith("<"):
            # A request that fell back to another model (usage.iterations has more than one
            # entry) is billed for every attempt, but the top-level usage only shows the last
            # one: count each iteration under its own model.
            its = u.get("iterations") or []
            calls = [(it.get("model") or m["model"], it) for it in its] if len(its) > 1 else [(m["model"], u)]
            key = d.get("requestId") or d.get("uuid")
            new = 0
            for i, (model, uu) in enumerate(calls):
                x, r = weight(model, uu, u.get("speed"))
                ctx = uu.get("input_tokens", 0) + uu.get("cache_read_input_tokens", 0) + uu.get("cache_creation_input_tokens", 0)
                k = key if i == 0 else f"{key}#{i}"
                is_new = k not in self.reqs
                self.reqs[k] = {
                    "t": t, "model": model, "fam": family(model), "x": x, "r": r, "ctx": ctx,
                    "in": uu.get("input_tokens", 0), "out": uu.get("output_tokens", 0),
                    "tokens": ctx + uu.get("output_tokens", 0),
                    "sid": sid, "agent": agent, "side": bool(d.get("isSidechain")),
                    "cwd": d.get("cwd") or "?", "ep": d.get("entrypoint") or "?",
                }
                if is_new:
                    self.last_new = max(self.last_new, t)
                    new += 1
            return int(new > 0)
        if typ == "user":
            c = m.get("content")
            if isinstance(c, str) and "Set model to" in c:
                g = SET_MODEL.search(c)
                if g:
                    self.switches.append((t, sid, g.group(1)))
            elif is_prompt(d):
                self.prompts.append((t, sid))
        return 0

    def since(self, t0):
        return [r for r in self.reqs.values() if r["t"] >= t0]


def project(cwd):
    return os.path.basename(cwd.rstrip("/")) or "~"


def summarize(recs):
    out = {"calls": 0, "tokens": 0, "x": 0.0, "r": 0.0, "by_platform": {}, "by_project": {}, "by_model": {}}
    groups = {"by_platform": lambda r: r["ep"], "by_project": lambda r: project(r["cwd"]), "by_model": lambda r: r["model"]}
    agg = {g: defaultdict(lambda: [0, 0, 0.0, 0.0]) for g in groups}
    for r in recs:
        out["calls"] += 1; out["tokens"] += r["tokens"]; out["x"] += r["x"]; out["r"] += r["r"]
        for g, fn in groups.items():
            a = agg[g][fn(r)]; a[0] += 1; a[1] += r["tokens"]; a[2] += r["x"]; a[3] += r["r"]
    for g in groups:
        out[g] = {k: {"calls": v[0], "tokens": v[1], "x": round(v[2], 5), "r": round(v[3], 5)} for k, v in agg[g].items()}
    out["x"], out["r"] = round(out["x"], 5), round(out["r"], 5)
    return out


def totals(recs, fam=None):
    fams = {fam} if isinstance(fam, str) else fam
    xs = [r for r in recs if fams is None or r["fam"] in fams]
    return round(sum(r["x"] for r in xs), 5), round(sum(r["r"] for r in xs), 5)


def daily(idx):
    """Per-day stats for the Overview/Models panels, all time (local dates)."""
    days, first = {}, {}
    blank = lambda: {"models": {}, "hours": [0] * 24, "msgs": 0, "sessions": 0}
    for r in idx.reqs.values():
        lt = r["t"].astimezone()
        day = days.setdefault(lt.date().isoformat(), blank())
        mm = day["models"].setdefault(r["model"], [0, 0, 0.0, 0.0, 0])
        mm[0] += r["in"]; mm[1] += r["out"]; mm[2] += r["x"]; mm[3] += r["r"]; mm[4] += 1
        day["hours"][lt.hour] += r["in"] + r["out"]
        day["msgs"] += 1
        if r["sid"] and (r["sid"] not in first or r["t"] < first[r["sid"]]):
            first[r["sid"]] = r["t"]
    for t, sid in idx.prompts:
        days.setdefault(t.astimezone().date().isoformat(), blank())["msgs"] += 1
    for t in first.values():
        days[t.astimezone().date().isoformat()]["sessions"] += 1
    for day in days.values():
        for mm in day["models"].values():
            mm[2], mm[3] = round(mm[2], 5), round(mm[3], 5)
    return days


def sessions(idx):
    """Per-session detail: models, switches, agents, context size, compactions."""
    by = defaultdict(list)
    for r in idx.reqs.values():
        by[r["sid"]].append(r)
    sw, comp = defaultdict(list), defaultdict(list)
    for t, sid, label in idx.switches:
        sw[sid].append((t, label))
    for c in idx.compactions:
        comp[c["sid"]].append(c)
    out = {}
    for sid, rs in by.items():
        rs.sort(key=lambda r: r["t"])
        main = [r for r in rs if not r["side"]]
        models = defaultdict(lambda: [0, 0.0, 0.0, 0])
        for r in rs:
            a = models[r["model"]]; a[0] += 1; a[1] += r["x"]; a[2] += r["r"]; a[3] += r["tokens"]
        changes, prev = [], None  # model changes on the main thread, as seen in the requests
        for r in main:
            if r["model"] != prev:
                changes.append({"t": r["t"].isoformat(), "model": r["model"]}); prev = r["model"]
        agents = defaultdict(lambda: {"calls": 0, "x": 0.0, "r": 0.0, "tokens": 0, "models": set(), "first": None, "last": None})
        for r in rs:
            if r["side"]:
                a = agents[r["agent"] or "?"]
                a["calls"] += 1; a["x"] += r["x"]; a["r"] += r["r"]; a["tokens"] += r["tokens"]; a["models"].add(r["model"])
                a["first"] = a["first"] or r["t"]; a["last"] = r["t"]
        ctxs = [r["ctx"] for r in main] or [0]
        last10 = main[-10:]
        cwd = next((r["cwd"] for r in rs if r["cwd"] != "?"), "?")
        out[sid] = {
            "id": (sid or "?")[:8], "title": idx.titles.get(sid), "project": project(cwd),
            "platform": ", ".join(sorted({r["ep"] for r in rs})),
            "start": rs[0]["t"].isoformat(), "last": rs[-1]["t"].isoformat(),
            "calls": len(rs), "x": round(sum(r["x"] for r in rs), 5), "r": round(sum(r["r"] for r in rs), 5),
            "tokens": sum(r["tokens"] for r in rs),
            "current_model": (main or rs)[-1]["model"],
            "models": {m: {"calls": a[0], "x": round(a[1], 5), "r": round(a[2], 5), "tokens": a[3]} for m, a in models.items()},
            "changes": changes[-12:],
            "switches": [{"t": t.isoformat(), "to": label} for t, label in sw.get(sid, [])][-12:],
            "agents": [{"id": aid[:10], **{k: v for k, v in (idx.agents.get(aid) or {}).items() if v is not None},
                        "calls": a["calls"], "x": round(a["x"], 5), "r": round(a["r"], 5), "tokens": a["tokens"],
                        "models": sorted(a["models"]), "first": a["first"].isoformat(), "last": a["last"].isoformat()}
                       for aid, a in sorted(agents.items(), key=lambda kv: -(kv[1]["x"] + kv[1]["r"]))][:25],
            "ctx_max": max(ctxs), "ctx_last": ctxs[-1], "ctx_avg": round(sum(ctxs) / len(ctxs)),
            # What a message costs right now: the last 10 main-thread calls, averaged.
            "recent": {"calls": len(last10), "x": round(sum(r["x"] for r in last10) / len(last10), 5),
                       "r": round(sum(r["r"] for r in last10) / len(last10), 5),
                       "ctx": round(sum(r["ctx"] for r in last10) / len(last10)), "model": last10[-1]["model"]} if last10 else None,
            "compactions": [{"t": c["t"].isoformat(), "trigger": c["trigger"], "pre": c["pre"], "post": c["post"]}
                            for c in comp.get(sid, [])],
        }
    return out, by


def context_stats(idx, sess, by):
    """Context-window analysis for every session ever logged on this laptop."""
    buckets = [{"lo": CTX_BUCKETS[i], "hi": CTX_BUCKETS[i + 1], "calls": 0, "x": 0.0, "r": 0.0, "by_fam": {}}
               for i in range(len(CTX_BUCKETS) - 1)]
    for r in idx.reqs.values():
        b = next(b for b in buckets if b["lo"] <= r["ctx"] < b["hi"])
        b["calls"] += 1; b["x"] += r["x"]; b["r"] += r["r"]
        f = b["by_fam"].setdefault(r["fam"], [0, 0.0, 0.0]); f[0] += 1; f[1] += r["x"]; f[2] += r["r"]
    for b in buckets:
        b["x"], b["r"] = round(b["x"], 5), round(b["r"], 5)
        b["by_fam"] = {k: [v[0], round(v[1], 5), round(v[2], 5)] for k, v in b["by_fam"].items()}
    # Each compaction: the 10 main-thread calls before vs. the 10 after.
    effects = []
    for c in idx.compactions:
        main = sorted((r for r in by.get(c["sid"], []) if not r["side"]), key=lambda r: r["t"])
        before = [r for r in main if r["t"] < c["t"]][-10:]
        after = [r for r in main if r["t"] > c["t"]][:10]
        if not before or not after:
            continue
        stat = lambda rs: {"calls": len(rs), "x": round(sum(r["x"] for r in rs) / len(rs), 5),
                           "r": round(sum(r["r"] for r in rs) / len(rs), 5),
                           "ctx": round(sum(r["ctx"] for r in rs) / len(rs)), "model": rs[-1]["model"]}
        effects.append({"t": c["t"].isoformat(), "sid": (c["sid"] or "?")[:8], "title": idx.titles.get(c["sid"]),
                        "trigger": c["trigger"], "pre": c["pre"], "post": c["post"],
                        "before": stat(before), "after": stat(after)})
    # Right after a compaction a session restarts from a small context: what does a call cost then?
    post = [e["after"] for e in effects]
    return {"buckets": buckets, "after_compact": post[-20:]}


def post(conf, path, body=None):
    req = urllib.request.Request(conf["HUB_URL"].rstrip("/") + path,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {conf['HUB_KEY']}",
                                          "Content-Type": "application/json"},
                                 method="GET" if body is None else "POST")
    with urllib.request.urlopen(req, timeout=120) as r:   # a refit on the hub can take a while
        return json.loads(r.read().decode())


def windows_of(off, now):
    w5 = now - timedelta(hours=5)
    if off and (off.get("five_hour") or {}).get("resets_at"):
        w5 = datetime.fromisoformat(off["five_hour"]["resets_at"]) - timedelta(hours=5)
    ww = now - timedelta(days=7)
    if off and (off.get("seven_day") or {}).get("resets_at"):
        ww = datetime.fromisoformat(off["seven_day"]["resets_at"]) - timedelta(days=7)
    return w5, ww


def sample(idx, off, now):
    """One calibration reading: the official %s next to this laptop's own logged usage in
    the same windows, split into x/r and Fable/other."""
    w5, ww = windows_of(off, now)
    s5, sw = idx.since(w5), idx.since(ww)
    fable = next((s for s in off.get("scoped") or [] if "fable" in (s.get("name") or "").lower()), None)
    LIGHT = {"sonnet", "haiku"}  # learned separately: the plan may weigh them unlike their price
    (x5, r5), (x5f, r5f), (x5l, r5l) = totals(s5), totals(s5, "fable"), totals(s5, LIGHT)
    (xw, rw), (xwf, rwf), (xwl, rwl) = totals(sw), totals(sw, "fable"), totals(sw, LIGHT)
    return {"t": now.isoformat(), "w5": off["five_hour"]["resets_at"], "p5": off["five_hour"].get("pct"),
            "ww": (off.get("seven_day") or {}).get("resets_at"), "pwr": (off.get("seven_day") or {}).get("pct"),
            "cc": next((b["percent"] for b in off.get("breakdown") or [] if b["key"] == "claude_code"), None),
            "wf": fable and fable["resets_at"], "pf": fable and fable["pct"],
            "x5": x5, "r5": r5, "x5f": x5f, "r5f": r5f, "xw": xw, "rw": rw, "xwf": xwf, "rwf": rwf,
            "x5l": x5l, "r5l": r5l, "xwl": xwl, "rwl": rwl, "pv": PRICE_VERSION}


def reprice(idx, todo):
    """Recompute past readings' logged totals with the current price table, from the logs.

    `todo` is [[t, w5, ww, wf], …] from the hub (readings it holds that were priced with an
    older table). Returns [[t, x5, r5, x5f, r5f, x5l, r5l, xw, rw, xwf, rwf, xwl, rwl], …]: what
    this laptop had logged in each reading's windows up to that moment, repriced.
    """
    import bisect
    reqs = sorted(idx.reqs.values(), key=lambda r: r["t"])
    times = [r["t"] for r in reqs]
    LIGHT = {"sonnet", "haiku"}
    out = []
    for t, w5, ww, _wf in todo:
        try:
            t = ts(t)
            end = bisect.bisect_right(times, t)
            s5 = reqs[bisect.bisect_left(times, ts(w5) - timedelta(hours=5)):end] if w5 else []
            sw = reqs[bisect.bisect_left(times, ts(ww) - timedelta(days=7)):end] if ww else []
        except Exception:
            continue
        row = [t.isoformat()]
        for group in (s5, sw):          # x, r, then Fable's, then Sonnet+Haiku's
            for part in (totals(group), totals(group, "fable"), totals(group, LIGHT)):
                row += list(part)
        out.append(row)
    return out


def snapshot(conf, idx, off, now, samples):
    w5, ww = windows_of(off, now)
    recent = idx.since(min(ww, now - timedelta(days=2)))
    hourly = defaultdict(lambda: {"x": 0.0, "r": 0.0})
    for r in recent:
        h = hourly[r["t"].replace(minute=0, second=0, microsecond=0).isoformat()]
        h["x"] += r["x"]; h["r"] += r["r"]
    sess, by = sessions(idx)
    newest = sorted(sess.values(), key=lambda s: s["last"], reverse=True)
    last = max((r["t"] for r in idx.reqs.values()), default=None)
    return {
        "device": conf["HUB_DEVICE"], "person": conf.get("HUB_PERSON", conf["HUB_DEVICE"]),
        "host": socket.gethostname(), "sent_at": now.isoformat(), "version": 4, "pv": PRICE_VERSION,
        "official": None if not off or off.get("from_hub") else off,
        "official_error": official.why, "windows_from_hub": bool(off and off.get("from_hub")),
        "account": account(idx.dirs),
        "window_start": w5.isoformat(), "week_start": ww.isoformat(),
        "last_activity": last.isoformat() if last else None,
        "window": summarize([r for r in recent if r["t"] >= w5]),
        "week": summarize([r for r in recent if r["t"] >= ww]),
        "hourly": {k: {"x": round(v["x"], 5), "r": round(v["r"], 5)} for k, v in sorted(hourly.items())},
        "sessions": newest[:25],
        "context": context_stats(idx, sess, by),
        "chats": chats(),
        "daily": daily(idx),
        "samples": samples,
    }


def main():
    conf = load_conf()
    for k in ("HUB_URL", "HUB_KEY", "HUB_DEVICE"):
        if not conf.get(k):
            sys.exit(f"missing {k} in {CONF}")
    idx = LogIndex(claude_dirs(conf))
    idx.update()
    state = {"pending": [], "last_sync": None, "last_read": None, "seen": idx.last_new, "synced_new": idx.last_new,
             "checked": time.time() - UPDATE_EVERY + 600}

    def read(now):
        """Official limits, or the hub's current windows (no %) when this laptop can't read them."""
        off = official(idx.dirs)
        notify(conf, off)
        return off or hub_windows(conf)

    def sync(now):
        off = read(now)
        if off and (off.get("five_hour") or {}).get("resets_at"):
            state["pending"].append(sample(idx, off, now))
        res = post(conf, "/api/ingest", snapshot(conf, idx, off, now, state["pending"][-200:]))
        if isinstance(res, dict) and res.get("rate"):
            cache_rate(res.pop("rate"))
        if isinstance(res, dict) and res.get("reprice"):
            # The hub holds readings priced with an older table: send them again, repriced.
            todo = res.pop("reprice")
            done = post(conf, "/api/reprice", {"device": conf["HUB_DEVICE"], "pv": PRICE_VERSION, "rows": reprice(idx, todo)})
            res["repriced"] = done.get("updated") if isinstance(done, dict) else done
        print(now.isoformat(timespec="seconds"), res, flush=True)
        state.update(pending=[], last_sync=now, last_read=now, seen=idx.last_new, synced_new=idx.last_new)

    if "--daemon" not in sys.argv:
        sync(datetime.now(timezone.utc))
        return

    def on_term(*_):  # systemctl stop/restart: push the readings taken since the last sync first
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, on_term)
    while True:
        try:
            now = datetime.now(timezone.utc)
            idx.update()
            since = None if state["last_sync"] is None else (now - state["last_sync"]).total_seconds()
            busy = idx.last_new > state["synced_new"]      # new Claude calls logged since the last sync
            due = since is None or since >= SYNC_EVERY or (busy and since >= BUSY_SYNC_EVERY)
            if not due and time.time() - state.get("polled", 0) >= REFRESH_POLL:
                state["polled"] = time.time()
                asked = post(conf, "/api/refresh").get("requested_at")
                due = bool(asked) and ts(asked) > state["last_sync"]
            if due:
                sync(now)
                if time.time() - state["checked"] >= UPDATE_EVERY:
                    state["checked"] = time.time()
                    if self_update(conf):   # nothing pending right after a sync: restart into it
                        os.execv(sys.executable, [sys.executable, os.path.abspath(__file__)] + sys.argv[1:])
            elif idx.last_new > state["seen"] and (now - state["last_read"]).total_seconds() >= SAMPLE_EVERY:
                # This laptop is busy: take an extra official reading for calibration.
                off = read(now)
                if off and (off.get("five_hour") or {}).get("resets_at"):
                    state["pending"].append(sample(idx, off, now))
                state.update(last_read=now, seen=idx.last_new)
        except SystemExit:
            if state["pending"]:
                try:
                    sync(datetime.now(timezone.utc))
                except Exception as e:
                    print(f"final sync failed: {e}", file=sys.stderr, flush=True)
            raise
        except Exception as e:  # network blips: keep the daemon alive
            print(f"sync failed: {e}", file=sys.stderr, flush=True)
        time.sleep(POLL_EVERY)


if __name__ == "__main__":
    main()
