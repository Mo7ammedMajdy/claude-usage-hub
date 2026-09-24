# Claude usage hub

A private dashboard for people who share one Claude plan. It shows:

- the official session (5-hour) and weekly limits, and each person's estimated share of them;
- a forecast for the week, built from how the account is really used;
- what one more message costs in each open Claude Code session, and whether /compact would help;
- every session down to its subagents, per-project and per-model breakdowns, and past weeks.

Each laptop runs a small background sync. It reads that laptop's Claude Code logs and the
official limits, and sends only numbers to your own hub (a free Vercel site with a free
database). A Claude Code statusline and a claude.ai browser script come with it.

## Setting it up

1. Unzip this folder.
2. Open Claude Code in it (`cd claude-usage-hub && claude`).
3. Say: **"Set this up."**

Claude follows `SETUP.md`. It asks you a few questions, deploys your own copy, and sets up your
laptop. It takes about 15 minutes. You'll do three things by hand:

1. Log in to Vercel once (free account).
2. Click Install once in your browser.
3. Send the other person one command to paste into a terminal on their laptop.

**You need:** Linux laptops (systemd), each logged into Claude Code with the shared account,
plus Python 3, curl and Node.js. A Mac or Windows laptop needs some adapting; `SETUP.md` says how.
