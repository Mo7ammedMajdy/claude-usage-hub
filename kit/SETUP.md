# Setting up the Claude usage hub (for Claude Code)

Work through the steps in order. Commands are bash; run each from this folder. `$HUB` stands
for the hub's address once step 4 has found it. Say what each step is for in a line before you
run it. The owner doesn't need to understand Vercel.

**Never print a key.** Keys go into files and commands through `$(python3 …)`, and reach the
other person through the clipboard. See the rules in `CLAUDE.md`.

## 1. Ask the owner (one message)
1. The first names of the people sharing the plan, as the dashboard should show them. Usually
   two, e.g. `Ahmed` and `Omar`. Use single words, no spaces.
2. Which of them is on this laptop.
3. Whether every laptop runs Linux. If one is a Mac or Windows, see "Other systems" at the end.

The laptops will be called `<Name>'s laptop`, unless the owner wants other names.

## 2. Check this laptop
```bash
for c in python3 curl node npx systemctl; do command -v $c >/dev/null || echo "missing: $c"; done
systemctl --user show-environment >/dev/null 2>&1 && echo "systemd user session: ok"
test -f ~/.claude/.credentials.json && echo "Claude Code login: found" || echo "Claude Code login: NOT found"
```
- **Node missing:** installing it needs sudo, so ask the owner to run it with the `!` prefix,
  e.g. `! sudo pacman -S nodejs npm` or `! sudo apt install nodejs npm`.
- **No Claude Code login:** the owner runs `claude` once and logs in with the **shared**
  account. Both laptops must use the same account; `/status` inside Claude Code shows which one.

## 3. Vercel account
Vercel hosts the hub for free (Hobby plan). The login is interactive, so ask the owner to type:
```
! npx -y vercel@59.23.2 login
```
Check it with `npx -y vercel@59.23.2 whoami`. If they have no account, the login page offers to
create one; "Continue with GitHub" or email both work.

## 4. First deploy: creates the project and its address
```bash
npx -y vercel@59.23.2 deploy --prod --yes 2>&1 | tail -15
```
The project gets this folder's name. The hub's **permanent address** is on the line starting `Aliased`,
e.g. `https://claude-usage-hub-ahmed.vercel.app`, not the long per-deploy URL. If no alias is
shown, run `npx -y vercel@59.23.2 inspect <the Production URL> 2>&1 | sed -n '/Aliases/,$p'` and
take the shortest `*.vercel.app` alias.
```bash
HUB=https://<the address>
curl -s -o /dev/null -w '%{http_code}\n' "$HUB/"      # must be 200
```
A 401 means Vercel Authentication covers production too. Have the owner turn it off for
production: Vercel dashboard → the project → Settings → Deployment Protection.

## 5. Database (free Upstash Redis, through Vercel)
```bash
npx -y vercel@59.23.2 integration add upstash/upstash-kv
npx -y vercel@59.23.2 env ls production 2>&1 | grep -E 'KV_REST_API_(URL|TOKEN)|UPSTASH_REDIS_REST_(URL|TOKEN)'
```
Pick the free plan if it asks. It may need the owner to accept Upstash's terms once. If it asks
something you can't answer from here, have the owner run it with `!`.

If the CLI can't do it, the owner can use the Vercel dashboard instead: the project →
Storage → Create Database → "Upstash for Redis" (free) → connect it to all environments. The
code only needs `KV_REST_API_URL` + `KV_REST_API_TOKEN`, or the `UPSTASH_REDIS_REST_*` pair.

## 6. Keys
The owner-only master key sees and changes everything. Each person also gets their own key, and
that key only sends usage under that person's name.
```bash
mkdir -p ~/.config/claude-usage-hub && (umask 077; python3 - "$HUB" Ahmed Omar <<'PY'
import json, pathlib, secrets, sys
url, *people = sys.argv[1:]
p = pathlib.Path.home() / ".config/claude-usage-hub/keys.json"
if p.exists():
    sys.exit("keys.json already exists: not overwriting it")
p.write_text(json.dumps({"url": url, "master": secrets.token_urlsafe(24),
                         "people": {n: secrets.token_urlsafe(24) for n in people}}, indent=2))
p.chmod(0o600)
print("keys saved for", ", ".join(people))
PY
)
```
(Use the real names from step 1.) Now hand the keys to Vercel. The values go through stdin, so
nothing is printed:
```bash
K="$HOME/.config/claude-usage-hub/keys.json"
python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['master'], end='')" "$K" \
  | npx -y vercel@59.23.2 env add HUB_KEY production --sensitive --yes
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(json.dumps({k: n for n, k in d['people'].items()}), end='')" "$K" \
  | npx -y vercel@59.23.2 env add HUB_VIEWERS production --sensitive --yes
```

## 7. Point the code at the address, deploy again
```bash
python3 configure.py "$HUB"          # in the git repo it is kit/configure.py
npx -y vercel@59.23.2 deploy --prod --yes 2>&1 | tail -5
```
Environment variables only take effect on a new deploy, so this second deploy is needed.

## 8. Check the hub (two requests, spaced out)
```bash
for n in Ahmed Omar; do
  curl -s -H "Authorization: Bearer $(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['people'][sys.argv[2]])" "$K" $n)" "$HUB/api/summary" \
    | python3 -c 'import json,sys; print("key works for:", json.load(sys.stdin).get("viewer"))'
  sleep 3
done
```
Each line should name its person. `None` or an error means the env vars or the database aren't
live yet: check steps 5–7.

## 9. This laptop
```bash
curl -fsSL "$HUB/collector/setup.sh" | bash -s -- "$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['people'][sys.argv[2]])" "$K" Ahmed)" "Ahmed's laptop" Ahmed
```
It installs three things and ends with a report (✓ fine, + done now, ! needs you):
1. **The sync service** (`claude-usage-sync`, a systemd user service).
2. **The Claude Code statusline**, merged into `~/.claude/settings.json`. A backup is kept, and a
   statusline that's already set up is left alone.
3. **The claude.ai browser script.** It opens the browser's userscript-manager page, and the
   owner clicks Add: Violentmonkey in Firefox, Tampermonkey in Chrome. Then the script's
   install page opens (click Install), then the dashboard, which logs that browser in.

Then check the service, and tell the owner to restart Claude Code so the statusline shows:
```bash
systemctl --user is-active claude-usage-sync && journalctl --user -u claude-usage-sync -n 5 --no-pager
```

## 10. The other person's laptop
Put their setup command on the clipboard. Don't show it: it contains their key.
```bash
N=Omar
CMD=$(python3 - "$N" <<'PY'
import json, pathlib, sys
d = json.loads((pathlib.Path.home() / ".config/claude-usage-hub/keys.json").read_text())
n = sys.argv[1]
print(f'curl -fsSL {d["url"]}/collector/setup.sh | bash -s -- {d["people"][n]} "{n}\'s laptop" {n}', end="")
PY
)
clip() { if [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wl-copy >/dev/null; then wl-copy
  elif [ -n "${DISPLAY:-}" ] && command -v xclip >/dev/null; then xclip -selection clipboard
  elif [ -n "${DISPLAY:-}" ] && command -v xsel >/dev/null; then xsel -bi
  elif command -v pbcopy >/dev/null; then pbcopy; else return 1; fi; }
if printf %s "$CMD" | clip; then echo "copied to the clipboard"
else (umask 077; printf '%s\n' "$CMD" > ~/claude-usage-setup-$N.txt); echo "no clipboard: saved to ~/claude-usage-setup-$N.txt"; fi
```
Tell the owner:
- The command is on their clipboard, or in that file. Send it to the other person privately
  (not in a group).
- The other person pastes it into a terminal on their laptop and presses Enter. That laptop
  must be logged into Claude Code with the shared account.
- Their browser asks for the same two clicks.

## 11. What to tell the owner at the end
- **Dashboard:** `$HUB` (already logged in on this laptop). The tabs are Overview, Activity,
  History and Accuracy.
- **Syncing:** laptops sync every 5 minutes, and every 2 minutes while busy. The refresh
  button asks them to sync right away.
- **"Calibrating":** the per-person split waits until the session % has risen a few points
  while a synced laptop is in use, which is usually within the first busy hour. The ± shrinks
  over the first days.
- **Forecast and history:** the forecast needs a few hours of the week. The Weeks table fills
  in from the first weekly reset.
- **Statusline** (Claude Code in a terminal): context %, session % with its reset countdown,
  messages left, and the week.

---

## Replacing keys
Do this whenever a key was printed, pasted somewhere public, or someone leaves.
1. Move `keys.json` aside, then run step 6 again. Pass `--force` to `env add` to overwrite.
2. Deploy (`npx -y vercel@59.23.2 deploy --prod --yes`).
3. Run step 9 again on this laptop, and step 10 for the other person. `setup.sh` swaps the key in place.
4. Browsers: open the dashboard once and log in with the new key; the userscript picks it up from there.

## Changing the hub later
- **Code:** edit, then `npx -y vercel@59.23.2 deploy --prod --yes`. The laptops fetch a new
  collector from the hub by themselves within 6 hours; rerunning `setup.sh` does it at once.
- **Browser script:** edit `userscript/core.js` or `main.js`, bump `VERSION` in
  `userscript/build.py`, run `python3 userscript/build.py`, then deploy. The userscript manager updates it.
- **Model prices:** they come from platform.claude.com/docs/en/about-claude/pricing. Update
  the table in `collector/claude-usage-sync.py` and bump `PRICE_VERSION`; the hub then reprices
  every laptop's history.

## Other systems
The collector (`collector/claude-usage-sync.py`) and the statusline are plain Python and run
anywhere. `install.sh` and `setup.sh` are Linux-only: they use systemd and Linux browser paths.
- **macOS:** run `python3 ~/.local/bin/claude-usage-sync --daemon` as a launchd agent, with
  RunAtLoad and KeepAlive, in `~/Library/LaunchAgents/`. Write the same
  `~/.config/claude-usage-sync/env` that `install.sh` writes. Claude Code keeps its login in the
  Keychain there, so the daemon can't read the official %. Give it a token instead: `claude
  setup-token` makes one; pass it as `CLAUDE_CODE_OAUTH_TOKEN` in the agent's
  EnvironmentVariables. Merge the statusline into `~/.claude/settings.json` the way `setup.sh`
  does, and install the userscript by hand from `$HUB/userscript/claude-usage.user.js`.
- **Windows:** simplest under WSL with systemd turned on (then it's Linux). Otherwise, a Task
  Scheduler task at logon that runs the daemon.

## Troubleshooting
- **Sync:** `journalctl --user -u claude-usage-sync -n 30 --no-pager`. The statusline shows
  "⚠ not syncing" when the last good sync is over 15 minutes old.
- **"can't read the official %"** (Overview footer): that laptop's Claude Code login expired.
  Opening Claude Code there once renews it.
- **HTTP 403 with a challenge page:** Vercel's bot protection. Wait about 10 minutes and don't
  retry in a loop. The laptops keep their readings and resend them.
- **Accuracy tab says the laptops are on different accounts:** one laptop is logged into a
  different Claude account, so its usage can't show up in the shared %.
