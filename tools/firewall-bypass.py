#!/usr/bin/env python3
"""Let the hub's own clients skip Vercel's automatic bot challenge.

A burst of scripted requests once got this machine challenged for ~10 min (403
x-vercel-mitigated: challenge), and the collectors can't solve a challenge. This adds (or
replaces) one custom firewall rule: requests whose Authorization header is one of the personal
hub keys ($HUB_KEYS_FILE, default ~/.config/claude-usage-hub/keys.json) are bypassed, system mitigations included
(bypassSystem). Everyone else is unaffected. Re-run after rotating a key. Prints no secrets.
  python3 tools/firewall-bypass.py          apply
  python3 tools/firewall-bypass.py --show   list the project's rules (names only)
"""
import json, os, sys, time, urllib.request, urllib.error

PROJECT = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".vercel", "project.json")))
AUTH = json.load(open(os.path.expanduser("~/.local/share/com.vercel.cli/auth.json")))
NAME = "Hub clients skip the bot challenge"

def api(method, path, body=None):
    q = f"projectId={PROJECT['projectId']}&teamId={PROJECT['orgId']}"
    req = urllib.request.Request(f"https://api.vercel.com{path}{'&' if '?' in path else '?'}{q}", method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {AUTH['token']}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

exp = AUTH.get("expiresAt") or 0
if exp and (exp / 1000 if exp > 1e12 else exp) < time.time():      # seconds (ms in older CLIs)
    sys.exit("the Vercel CLI login has expired: run any `npx vercel` command once to refresh it")

status, cfg = api("GET", "/v1/security/firewall/config/active")
rules = (cfg.get("rules") or []) if status == 200 else []
print("current config:", status, "| rules:", [r.get("name") for r in rules])
if "--show" in sys.argv:
    sys.exit(0)

kf = json.load(open(os.path.expanduser(os.environ.get("HUB_KEYS_FILE", "~/.config/claude-usage-hub/keys.json"))))
# the kit writes {"people": {name: key}}; a plain {key: name} map works too
keys = list(kf["people"].values()) if isinstance(kf.get("people"), dict) else list(kf.keys())
rule = {
    "name": NAME,
    "description": "Collectors, statusline and the userscript send a personal hub key; don't challenge them.",
    "active": True,
    # condition groups are OR'ed; one per key
    "conditionGroup": [{"conditions": [{"type": "header", "key": "authorization", "op": "eq", "value": f"Bearer {k}"}]} for k in keys],
    "action": {"mitigate": {"action": "bypass", "bypassSystem": True}},
}
old = next((r for r in rules if r.get("name") == NAME), None)
if old:
    status, out = api("PATCH", "/v1/security/firewall/config", {"action": "rules.update", "id": old["id"], "value": rule})
else:
    status, out = api("PATCH", "/v1/security/firewall/config", {"action": "rules.insert", "id": None, "value": rule})
if status >= 300:
    # no firewall config yet on this project: create it with the rule
    print("patch answered", status, (out.get("error") or {}).get("message"))
    status, out = api("PUT", "/v1/security/firewall/config", {"firewallEnabled": True, "rules": [rule]})
print("result:", status, (out.get("error") or {}).get("message") or "ok")
status, cfg = api("GET", "/v1/security/firewall/config/active")
print("now:", status, [ (r.get("name"), r.get("active"), (r.get("action") or {}).get("mitigate")) for r in cfg.get("rules") or []])
