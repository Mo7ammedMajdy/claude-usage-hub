# How the Claude usage hub works

Read this before changing anything. `SETUP.md` covers installing it.

## Pieces
- **`collector/claude-usage-sync.py`**: runs on each laptop as a systemd user service
  (`claude-usage-sync --daemon`).
  - Tails `~/.claude/projects/**/*.jsonl` incrementally (subagents included) and prices every API
    call at API rates into two numbers: **x** (input, output and cache writes) and **r** (cache
    reads).
  - Reads the official limits from `https://api.anthropic.com/api/oauth/usage`, using the
    laptop's Claude Code login.
  - Syncs to the hub's `/api/ingest` every 5 minutes, every 2 while busy, and within about a
    minute of the dashboard's Refresh. While busy it also takes a calibration reading (official %
    next to logged usage) about once a minute.
  - Survives outages: it backs off from 60 s up to 15 min, honours Retry-After, and keeps unsent
    readings in `~/.cache/claude-usage/pending.jsonl`.
  - Writes `~/.cache/claude-usage/{official,rate,sync}.json` for the statusline.
  - Updates itself from the hub every 6 hours.
  - Sends desktop notifications (notify-send) at session 80/95% and week 90/97%.
  - Config lives in `~/.config/claude-usage-sync/env` (`HUB_URL`, `HUB_KEY`, `HUB_DEVICE`, `HUB_PERSON`).
- **`collector/claude-statusline.py`**: the Claude Code statusline. It shows context %, session %
  with its reset countdown, what this chat has used, "~N msgs left" (from the median cost of this
  chat's recent typed messages, subagents included), the week, and "⚠ not syncing".
  - It makes no network calls; it reads the cache files above.
  - `--hook` is a UserPromptSubmit hook that suggests /compact above 85% context.
- **`collector/setup.sh`** + **`install.sh`**: one idempotent command per laptop (daemon,
  statusline, browser script). No prompts, and safe to rerun. Options: `--dry-run`, `--no-browser`.
- **`userscript/`**: the claude.ai browser script (Violentmonkey or Tampermonkey).
  - It reads clones of responses the page fetches anyway (the completion stream, the conversation
    and /usage), and draws one line under the message box: context size, next-message cost and
    limits.
  - It reports chats' sizes to the hub, as numbers only.
  - Build: `python3 userscript/build.py` joins `core.js` + `main.js` into `claude-usage.user.js`.
- **`api/`**: Vercel functions, backed by Upstash Redis.
  - `ingest.js`: validates each snapshot against an allowlist, stores it, and refits the model
    (`_fit.js`, `_combine.js`), the forecast (`_forecast.js`) and the live unlogged signal
    (`_unlogged.js`).
  - `state.js` / `detail.js` / `summary.js`: what the dashboard reads. `summary.js` splits
    the usage by person (`_split.js`).
  - `refresh.js`: the "sync now" request and change stamp. `reprice.js`: re-pricing after a
    price-table change. `remove.js`: drops a device. `web.js`: the browser script's reports.
- **`index.html`**: the whole dashboard, in one file (inline JS and CSS). Four views:
  - Overview: limits with the per-person split, laptop status, open sessions' cost per message,
    and the 24-hour charts.
  - Activity: sessions with their subagents, breakdowns, claude.ai chats.
  - History: weeks, 5-hour sessions, all-time stats.
  - Accuracy: per-laptop table, the fit's ±, how it works, per-model costs.

## Keys and privacy
- `HUB_KEY` is the master key; it sees everything. `HUB_VIEWERS` is a JSON map of
  `{key: person}`, and each person's key can only send usage under that person's name.
- `redact()` in `api/_lib.js` hides the other person's project names and chat titles
  server-side. Everyone sees the numbers; only you see your own project names.
- Vercel serves every file not listed in `.vercelignore` as a static file. Anything internal
  must go in `.vercelignore`.
- The Content-Security-Policy is set in `vercel.json`. In `index.html`, every API number goes
  through `num()` and every string through `esc()` before reaching innerHTML.

## How the estimate works
Anthropic doesn't publish how much each model or token counts against a plan's limits, so the hub
measures it. Within one 5-hour window:

    official % = floor( a · U + O )
    U = (x + ρ·r)_opus + φ·(x + ρ·r)_fable + ψ·(x + ρ·r)_sonnet/haiku

- **a** is % per API-dollar. On Max 5x it was about 0.6–0.8% of a session per dollar of Opus.
- **ρ** is what cache reads count relative to their API price (about 0.5).
- **φ** is Fable's weight versus its price (about 3.5).
- **ψ** is Sonnet/Haiku's weight.
- **O** is usage no synced laptop logged (claude.ai, the apps, other computers). It can only grow.

`_fit.js` searches a grid of (a, ρ, φ, ψ) for the rates that need the least unlogged usage
without ever over-counting a reading. The whole-point rounding of each reading pins it down, and
a lag of ±5 min is allowed between the logs and the official %.

- **Range:** every rate within about 2 points of the best one.
- **±:** measured. Each past window with a 5+ point rise is checked against what the official %
  really did. Windows whose logs fall more than 25% short had unlogged use and are set aside.
- **Week and Fable:** the week reuses the session's weights and learns only its own rate (about
  8.5 sessions to a week). Fable's own weekly limit is fitted separately.

Until there's enough data, every estimate shows "calibrating" or a range, never a made-up
number.

## Forecast (`api/_forecast.js`)
- **Pace:** the recent pace comes from the last 72 hours, weighted with a 30-hour half-life.
- **Range:** the expected end of week, the P10–P90 range and the chance of hitting the limit
  come from 400 replays of whole days drawn from the account's own history.
- **One-offs:** days in the Redis list `forecast:ignore` are left out of the pace, but they
  still count as possible busy days.
- **Track record:** a forecast is saved every 6 hours and scored once the week ends (History → Weeks).

## Redis keys
- `devices`, `detail`, `ds:<device>`: the latest snapshots and each device's readings.
- `fit`, `line`, `stamp`, `refresh`, `pv`, `owner`.
- `weeks`, `week:current`, `week:archived:<id>`: weekly history.
- `forecast:ignore`, `fit:lock`.
- `web:*`: the browser script's reports.

## Rules learned the hard way
- Never send bursts of requests at the live hub. About 30 quick scripted requests trip Vercel's
  bot protection for about 10 minutes, which also blocks every laptop's sync. The Hobby plan has
  no bypass.
- Never scrape claude.ai (Consumer Terms §3). Passive reading of what the page already fetched
  is the line.
- Never print keys. If one leaks, replace it (`SETUP.md` → "Replacing keys").
- Prices must match platform.claude.com's pricing page. One wrong row once skewed Fable's
  weight from 3.8 to 11.6. After changing the table, bump `PRICE_VERSION`.
- Vercel Blob is unusable here (Hobby allows 2,000 writes a month); that's why the hub uses Redis.
