#!/usr/bin/env bash
# Set up — or repair — one laptop on the shared Claude usage hub. Checks every piece, installs
# or updates only what is missing or out of date, and ends with a report. No questions asked;
# safe to run again at any time.
#
#   curl -fsSL https://claude-usage-hub.vercel.app/collector/setup.sh | bash -s -- <KEY> "<device name>" <person>
#
# Options after the three arguments:
#   --dry-run      only report; change nothing, open nothing
#   --no-browser   skip the browser part (no tabs opened)
#   --reassign     the laptop was set up for someone else and is now this person's
#
# Pieces:
#   1. the sync daemon (systemd user service) that sends this laptop's Claude Code usage
#   2. the Claude Code statusline + the "run /compact" nudge (in Claude Code's settings.json)
#   3. the claude.ai userscript, via Violentmonkey (Firefox) or Tampermonkey (Chromium family).
#      Installing into a browser needs one click from a person; this opens the right page, waits
#      for the manager to appear, then opens the script's install page and the dashboard once.
set -uo pipefail

HUB="${HUB_URL:-https://claude-usage-hub.vercel.app}"
[ $# -ge 3 ] || { echo "usage: setup.sh <KEY> \"<device name>\" <person> [--dry-run] [--no-browser]"; exit 1; }
KEY=$1 DEVICE=$2 PERSON=$3; shift 3
DRY=0 BROWSER=1
REASSIGN=0
for a in "$@"; do case $a in --dry-run) DRY=1 ;; --no-browser) BROWSER=0 ;; --reassign) REASSIGN=1 ;; esac; done

BIN="$HOME/.local/bin"; CONF="$HOME/.config/claude-usage-sync"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
REPORT=()
ok()   { REPORT+=("  ✓ $*"); }
did()  { REPORT+=("  + $*"); }
todo() { REPORT+=("  ! $*"); }
say()  { printf '\033[2m· %s\033[0m\n' "$*"; }
run()  { if [ $DRY = 1 ]; then say "(dry run) would: $*"; else "$@"; fi; }
same() { [ -f "$1" ] && [ -f "$2" ] && cmp -s "$1" "$2"; }

# ------------------------------------------------------------------ 0. basics
for c in python3 curl systemctl; do
  command -v $c >/dev/null || { echo "missing: $c — install it and run this again"; exit 1; }
done
who=$(curl -s -H "Authorization: Bearer $KEY" "$HUB/api/summary" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("viewer") or "")
except Exception: print("")')
[ -n "$who" ] || { echo "the hub rejected this key — ask for a fresh setup command"; exit 1; }
[ "$who" != "*" ] || { echo "that's the hub's master key, not a personal one — ask for a personal setup command"; exit 1; }
[ "$who" = "$PERSON" ] || todo "this key belongs to \"$who\", not \"$PERSON\" — usage will be filed under $who"
# Someone else's command pasted on the wrong laptop would file this laptop's usage under them.
was=$(sed -n 's/^HUB_PERSON=//p' "$CONF/env" 2>/dev/null)
if [ -n "$was" ] && [ "$was" != "$PERSON" ] && [ $REASSIGN = 0 ]; then
  echo "This laptop is already set up for $was ($(sed -n 's/^HUB_DEVICE=//p' "$CONF/env")). This command is for $PERSON: run it on $PERSON's laptop."
  echo "(If this laptop really is $PERSON's now, run it again with --reassign at the end.)"
  exit 1
fi
ok "hub reachable, key accepted ($who)"
[ -d "$CLAUDE_DIR/projects" ] && ok "Claude Code logs found in ${CLAUDE_DIR/#$HOME/~}" \
  || todo "no Claude Code logs yet in ${CLAUDE_DIR/#$HOME/~} — the daemon will pick them up once Claude Code has run"

# ------------------------------------------------------------------ 1. sync daemon
say "checking the sync daemon"
curl -fsSL "$HUB/collector/claude-usage-sync.py" -o "$TMP/sync.py" || { echo "couldn't download the collector"; exit 1; }
envv() { sed -n "s/^$1=//p" "$CONF/env" 2>/dev/null; }
why=()
same "$TMP/sync.py" "$BIN/claude-usage-sync" || why+=("$([ -f "$BIN/claude-usage-sync" ] && echo "out of date" || echo "not installed")")
[ "$(envv HUB_KEY)" = "$KEY" ]       || why+=("$([ -n "$(envv HUB_KEY)" ] && echo "old key" || echo "no key")")
[ "$(envv HUB_DEVICE)" = "$DEVICE" ] || why+=("device name")
[ "$(envv HUB_PERSON)" = "$PERSON" ] || why+=("person")
[ "$(envv HUB_URL)" = "$HUB" ]       || why+=("hub address")
systemctl --user is-active --quiet claude-usage-sync.service || why+=("not running")
systemctl --user is-enabled --quiet claude-usage-sync.service 2>/dev/null || why+=("not starting at login")
if [ ${#why[@]} -eq 0 ]; then
  ok "sync daemon up to date and running"
else
  say "sync daemon needs work: ${why[*]}"
  if [ $DRY = 1 ]; then did "(dry run) would reinstall the sync daemon: ${why[*]}"
  else
    curl -fsSL "$HUB/collector/install.sh" -o "$TMP/install.sh" && bash "$TMP/install.sh" "$HUB" "$KEY" "$DEVICE" "$PERSON" >"$TMP/install.log" 2>&1
    if grep -q "^OK: synced" "$TMP/install.log"; then did "sync daemon installed/updated (${why[*]}) and syncing"
    else todo "sync daemon installed but no confirmed sync yet — check: journalctl --user -u claude-usage-sync -n 20"; fi
  fi
fi

# ------------------------------------------------------------------ 2. statusline + nudge
say "checking the Claude Code statusline"
curl -fsSL "$HUB/collector/claude-statusline.py" -o "$TMP/statusline.py" || todo "couldn't download the statusline"
if [ -s "$TMP/statusline.py" ]; then
  if same "$TMP/statusline.py" "$BIN/claude-statusline"; then ok "statusline script up to date"
  else run install -Dm755 "$TMP/statusline.py" "$BIN/claude-statusline" && did "statusline script installed/updated"; fi
  # Merge into settings.json: add ours, never replace someone else's statusline; back up first.
  DRY=$DRY SETTINGS="$CLAUDE_DIR/settings.json" SL="$BIN/claude-statusline" python3 - <<'PY' >"$TMP/merge.out"
import json, os, pathlib, shutil, time
p = pathlib.Path(os.environ["SETTINGS"]); sl = os.environ["SL"]; dry = os.environ["DRY"] == "1"
try:
    s = json.loads(p.read_text()) if p.exists() else {}
except Exception:
    print("todo settings.json isn't valid JSON — left alone"); raise SystemExit
before = json.dumps(s, sort_keys=True)
cur = s.get("statusLine") or {}
if not cur:
    s["statusLine"] = {"type": "command", "command": sl, "refreshInterval": 30}
    print("did statusline turned on")
elif "claude-statusline" in str(cur.get("command", "")):
    if cur.get("refreshInterval") != 30 or cur.get("command") != sl:
        cur.update(command=sl, refreshInterval=30); print("did statusline settings refreshed")
    else:
        print("ok statusline already on")
else:
    print("todo kept the statusline that was already configured (" + str(cur.get("command", ""))[:60] + ")")
ups = s.setdefault("hooks", {}).setdefault("UserPromptSubmit", [])
if any("claude-statusline" in h.get("command", "") for e in ups for h in e.get("hooks", [])):
    print("ok /compact nudge already on")
else:
    ups.append({"hooks": [{"type": "command", "command": sl + " --hook"}]}); print("did /compact nudge turned on")
if json.dumps(s, sort_keys=True) != before and not dry:
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists():
        shutil.copy2(p, p.with_name(f"settings.json.bak-{time.strftime('%Y%m%d-%H%M%S')}"))
    p.write_text(json.dumps(s, indent=2) + "\n")
    print("did settings.json saved (backup next to it)")
PY
  while read -r kind msg; do
    case $kind in ok) ok "$msg" ;; did) did "$([ $DRY = 1 ] && echo "(dry run) would: ")$msg" ;; todo) todo "$msg" ;; esac
  done <"$TMP/merge.out"
fi

# ------------------------------------------------------------------ 3. browsers + userscript
USERSCRIPT="$HUB/userscript/claude-usage.user.js"
DASH="$HUB/#key=$KEY"
VM_FF='{aecec67f-0d10-4fa7-b7c7-609a2db280cf}'  TM_FF='firefox@tampermonkey.net'
VM_CR='jinjaccalgkegednnccohejagnlnfdag'          TM_CR='dhdgffkkebhmkfjojejmpbldmpobfkfo'
MARK="$CONF/browser-setup"; mkdir -p "$MARK" 2>/dev/null || true
GUI=0; [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && GUI=1
recent() { [ -n "$(find "$1" -maxdepth 0 -mtime -30 2>/dev/null)" ]; }   # used in the last 30 days
first()  { for b in "$@"; do command -v "$b" >/dev/null && { echo "$b"; return; }; done; }
open_in() {  # browser-binary url
  if [ $DRY = 1 ] || [ $BROWSER = 0 ]; then say "would open in ${1:-default browser}: ${2%%#*}"; return; fi
  # No screen to open it on: say where to go, but never print the key that rides in the link.
  if [ $GUI = 0 ]; then case $2 in *"#key="*) todo "open ${2%%#*} in your browser and log in with your key" ;; *) todo "open this in your browser: $2" ;; esac; return; fi
  # $1 unquoted on purpose: it can be a multi-word launcher ("flatpak run org.mozilla.firefox").
  if [ -n "$1" ]; then nohup $1 "$2" >/dev/null 2>&1 & else nohup xdg-open "$2" >/dev/null 2>&1 & fi
  sleep 2
}
# Wait (up to 3 min) for a userscript manager to show up after its store page was opened.
wait_for() {  # check-command...
  [ $DRY = 1 ] || [ $BROWSER = 0 ] || [ $GUI = 0 ] && return 1
  say "waiting for the extension to be installed (click Add/Install in the browser; up to 3 min)"
  for _ in $(seq 36); do "$@" && return 0; sleep 5; done; return 1
}
finish_browser() {  # name binary — userscript + dashboard key, once per browser
  local name=$1 bin=$2 ver
  ver=$(curl -fsSL "$USERSCRIPT" | sed -n 's|^// @version *||p' | head -1)
  if [ -f "$MARK/$name" ]; then
    ok "$name: userscript set up earlier (v$(cat "$MARK/$name")); the manager keeps it updated"
    return
  fi
  open_in "$bin" "$USERSCRIPT"; sleep 3
  open_in "$bin" "$DASH"          # the userscript picks the key up from here
  if [ $DRY = 0 ] && [ $BROWSER = 1 ] && [ $GUI = 1 ]; then
    echo "$ver" >"$MARK/$name"
    did "$name: opened the userscript install page (click Install) and the dashboard (hands it the key)"
  elif [ $DRY = 1 ]; then
    did "(dry run) would open the userscript v$ver install page and the dashboard in $name"
  fi
}

found_any=0
# Only push an install into the default browser; others are set up only if they already have a
# userscript manager (someone chose to use them for this).
DEFAULT=$(xdg-settings get default-web-browser 2>/dev/null | tr 'A-Z' 'a-z')
is_default() { case "$DEFAULT" in *"$1"*) return 0 ;; esac; [ -z "$DEFAULT" ]; }
if [ $BROWSER = 1 ] || [ $DRY = 1 ]; then
  say "checking browsers"
  # Firefox (regular, XDG and Flatpak locations): the profile in use is the one whose prefs.js
  # was written most recently.
  prof=$(ls -t "$HOME"/.mozilla/firefox/*/prefs.js "$HOME"/.config/mozilla/firefox/*/prefs.js \
           "$HOME"/.var/app/org.mozilla.firefox/.mozilla/firefox/*/prefs.js 2>/dev/null | head -1)
  prof=${prof%/prefs.js}
  if [ -n "$prof" ] && recent "$prof"; then
    found_any=1; ext="$prof/extensions.json"
    has_mgr() { grep -qF -e "$VM_FF" -e "$TM_FF" "$ext" 2>/dev/null; }
    bin=$(first firefox firefox-esr)
    [ -z "$bin" ] && [[ $prof == *"/.var/app/"* ]] && bin="flatpak run org.mozilla.firefox"
    if has_mgr; then ok "Firefox: userscript manager installed"; finish_browser firefox "$bin"
    elif ! is_default firefox; then todo "Firefox: not your default browser, skipped (no userscript manager in it)"
    else
      open_in "$bin" "https://addons.mozilla.org/firefox/addon/violentmonkey/"
      if wait_for has_mgr; then did "Firefox: Violentmonkey installed"; finish_browser firefox "$bin"
      else todo "Firefox: install Violentmonkey (page opened), then run this again"; fi
    fi
  fi
  # Chromium family
  for pair in "chromium:chromium chromium-browser" "google-chrome:google-chrome-stable google-chrome" \
              "BraveSoftware/Brave-Browser:brave brave-browser" "microsoft-edge:microsoft-edge-stable microsoft-edge" \
              "vivaldi:vivaldi-stable vivaldi"; do
    dir=${pair%%:*}; bins=${pair#*:}; root="$HOME/.config/$dir"
    [ -d "$root" ] || continue
    for prof in "$root"/Default "$root"/Profile\ *; do
      [ -d "$prof/Extensions" ] && recent "$prof" || continue
      found_any=1; name=$(basename "$dir" | tr 'A-Z' 'a-z'); bin=$(first $bins)
      has_mgr() { [ -d "$prof/Extensions/$TM_CR" ] || [ -d "$prof/Extensions/$VM_CR" ]; }
      brand=$(echo "$dir" | sed 's|.*/||; s|-browser$||' | tr 'A-Z' 'a-z')   # chromium, google-chrome, brave, …
      if has_mgr; then ok "$name: userscript manager installed"; finish_browser "$name" "$bin"
      elif ! is_default "${brand%%-*}"; then todo "$name: not your default browser, skipped (no userscript manager in it)"
      else
        open_in "$bin" "https://chromewebstore.google.com/detail/tampermonkey/$TM_CR"
        if wait_for has_mgr; then did "$name: Tampermonkey installed"; finish_browser "$name" "$bin"
        else todo "$name: install Tampermonkey (page opened), then run this again"; fi
      fi
      # Chromium's extension rules make Tampermonkey ask for this once; Violentmonkey doesn't.
      [ -d "$prof/Extensions/$TM_CR" ] && todo "$name: if the userscript doesn't run, open the extensions page → Tampermonkey → Details → turn on \"Allow User Scripts\""
      break
    done
  done
  [ $found_any = 1 ] || todo "no Firefox or Chromium-family browser profile found — install the userscript by hand: $USERSCRIPT"
fi

# ------------------------------------------------------------------ report
echo
echo "Claude usage hub — $DEVICE ($PERSON)"
printf '%s\n' "${REPORT[@]}"
echo
echo "  ✓ = already fine   + = done now   ! = needs you"
echo "  Dashboard: $HUB  (log in once with the link this script opened)"
echo "  Note: the statusline shows in the Claude Code terminal, not in the VS Code extension."
