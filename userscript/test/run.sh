#!/bin/bash
# Headless Firefox against a mock claude.ai (nonce-only script CSP, no inline styles), with the
# userscript running as a content script — the mode Violentmonkey falls back to on claude.ai.
#   ./run.sh hook   core.js alone: does the fetch hook see the stream, tree and /usage?
#   ./run.sh full   the built userscript: hook + UI + hub posts (hub calls go to the mock)
# Needs: firefox, python3, npx (web-ext). Prints what the page, the hook and the UI reported.
cd "$(dirname "$0")"
MODE=${1:-full}
if [ "$MODE" = hook ]; then EXT=hook-only; cp ../core.js hook-only/; URL=/chat/11111111-2222-3333-4444-555555555555
else EXT=full; (cd .. && python3 build.py >/dev/null)
  # Run it the way Violentmonkey's content-mode sandbox does: a proxied window without
  # wrappedJSObject, and unsafeWindow = the content script's own window.
  { echo "(function (window, unsafeWindow) {"; cat ${USERSCRIPT:-../claude-usage.user.js}
    echo "})(new Proxy(window, { get(t, k) { if (k === 'wrappedJSObject') return undefined; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } }), window);"
  } > full/claude-usage.user.js; URL=/chat/11111111-2222-3333-4444-555555555555${LATE:+?late}; fi
pkill -f "[s]erver.py 8765"; sleep 0.5
: > report.log
python3 server.py 8765 report.log & SRV=$!
sleep 1
timeout 60 npx -y web-ext run --source-dir $EXT --firefox "$(command -v firefox)" --arg=--headless \
  --start-url "http://127.0.0.1:8765$URL" --start-url http://127.0.0.1:8765/settings/usage --no-reload --no-input > webext.log 2>&1 & WX=$!
for i in $(seq 1 45); do sleep 1; grep -q "^ui\|^hook" report.log && grep -q "^page" report.log && break; done
sleep 4
kill $WX $SRV 2>/dev/null; pkill -f "[f]irefox.*firefox-profile"   # only web-ext's temp profiles
python3 -c '
import json
for line in open("report.log"):
    who, _, body = line.partition("\t")
    try: d = json.loads(body)
    except Exception: d = body.strip()
    print(who.upper() + ":", json.dumps(d)[:300])'
[ -n "$KEEP" ] || rm -f report.log webext.log
