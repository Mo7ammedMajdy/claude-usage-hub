# tools/ — local only (excluded from the deploy by .vercelignore)

- `dump.mjs` — pull every device's calibration readings from Redis into `data/samples.json`.
- `backtest.mjs` — leave-one-window-out back-test of the session fit: predicts each window's
  official rise from a fit on the others. `node tools/backtest.mjs tools/data/samples.json D`
  (configs A/B/D/E/F/G at the top; D = the deployed settings).
- `refit-audit.mjs` — refit the dumped readings with the repo's code and print the result.
- `reqs.py` — independent re-read of this laptop's Claude Code logs (dedupe by requestId, raw
  token parts) → `data/reqs.json`; used to check the collector's totals to the cent.
- `shoot.py` — Playwright screenshots of the live dashboard at 1300/1920/420 px → `data/`.
- `bidi.mjs` — minimal WebDriver BiDi client for a *copied* Firefox profile (never the real
  one: remote debugging sets navigator.webdriver and trips Cloudflare).
- `data/samples-2026-09-24-before-reprice.json` — backup of all readings before the price fix.
