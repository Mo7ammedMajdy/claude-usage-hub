# Claude usage hub: notes for Claude Code

- **Not set up yet** (there is no `~/.config/claude-usage-hub/keys.json`): follow `SETUP.md`
  from step 1, in order.
- **Changing or fixing the hub later:** read `HOW-IT-WORKS.md` first.

## Rules
- **Never print a hub key.** That covers chat, command output, `set -x`, `curl -v` and reports.
  Keys live in `~/.config/claude-usage-hub/keys.json` (mode 600) and in each laptop's
  `~/.config/claude-usage-sync/env`. Read them inside commands with `$(python3 …)`, and hand
  them over through the clipboard. A key that got printed must be replaced (`SETUP.md` → "Replacing keys").
- **Never send bursts of requests to the live hub.** About 30 quick requests in a row trip
  Vercel's bot protection, and then every laptop's sync is blocked for about 10 minutes.
  Test against a local copy, or space requests out.
- **Never scrape claude.ai.** The browser script only reads responses the page already
  fetched. Keep it that way: automated access breaks Anthropic's Consumer Terms (§3).
- **Never show made-up numbers.** Where the data can't support a figure yet, the dashboard
  says "calibrating" or shows a range. Keep it that way.
