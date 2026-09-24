#!/usr/bin/env bash
# Install the Claude usage sync on a Linux machine (systemd user service: every 5 min + on Refresh).
# Usage: curl -fsSL <HUB_URL>/collector/install.sh | bash -s -- <HUB_URL> <HUB_KEY> <device-name> <person-name>
set -euo pipefail
[ $# -eq 4 ] || { echo "usage: $0 <HUB_URL> <HUB_KEY> <device-name> <person-name>"; exit 1; }
bin="$HOME/.local/bin"; conf="$HOME/.config/claude-usage-sync"; units="$HOME/.config/systemd/user"
mkdir -p "$bin" "$conf" "$units"
curl -fsSL "${1%/}/collector/claude-usage-sync.py" -o "$bin/claude-usage-sync" && chmod 755 "$bin/claude-usage-sync"
umask 077
# Renaming? Drop the old device entry from the hub so it doesn't linger as "offline".
old=$(sed -n 's/^HUB_DEVICE=//p' "$conf/env" 2>/dev/null || true)
if [ -n "$old" ] && [ "$old" != "$3" ]; then
  curl -fsS -X POST -H "Authorization: Bearer $2" -H "Content-Type: application/json" \
    -d "{\"device\": $(printf '%s' "$old" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}" \
    "${1%/}/api/remove" >/dev/null && echo "removed old device entry: $old"
fi
printf 'HUB_URL=%s\nHUB_KEY=%s\nHUB_DEVICE=%s\nHUB_PERSON=%s\n' "$1" "$2" "$3" "$4" > "$conf/env"
# Older installs used a 3-minute timer; the daemon replaces it.
systemctl --user disable --now claude-usage-sync.timer 2>/dev/null || true
rm -f "$units/claude-usage-sync.timer"
cat > "$units/claude-usage-sync.service" <<UNIT
[Unit]
Description=Push Claude usage to the shared dashboard (every 5 min + on Refresh)
After=network-online.target

[Service]
ExecStart=/usr/bin/env python3 $bin/claude-usage-sync --daemon
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable claude-usage-sync.service
since=$(date '+%Y-%m-%d %H:%M:%S')
systemctl --user restart claude-usage-sync.service
# The first sync reads every log on the laptop, which can take a while: wait up to 90 s for it.
for _ in $(seq 45); do
  sleep 2
  journalctl --user -u claude-usage-sync --since "$since" --no-pager 2>/dev/null | grep -q "'ok': True" && break
done
if journalctl --user -u claude-usage-sync --since "$since" --no-pager | grep -q "'ok': True"; then
  echo "OK: synced. Runs in the background (systemctl --user status claude-usage-sync)"
else
  journalctl --user -u claude-usage-sync -n 10 --no-pager
fi
