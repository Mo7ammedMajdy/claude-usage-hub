#!/usr/bin/env python3
"""Screenshots of the built userscript on the mock pages (Chromium, page mode), dark and light.
Needs the mock running: python3 server.py 8765 /dev/null &   Writes shot-<page>-<theme>.png here."""
import pathlib, sys, time
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
shim = (HERE / "full/shim.js").read_text()
us = (HERE.parent / "claude-usage.user.js").read_text()
pages = {"chat": "/chat/11111111-2222-3333-4444-555555555555", "usage": "/settings/usage"}
errs = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/chromium", args=["--remote-debugging-port=0"])
    for theme in ("dark", "light"):
        for name, path in pages.items():
            pg = b.new_page(viewport={"width": 900, "height": 520})
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.add_init_script(shim + "\n" + us)
            pg.goto("http://127.0.0.1:8765" + path + ("?light" if theme == "light" else ""))
            time.sleep(float(sys.argv[1]) if len(sys.argv) > 1 else 3.5)
            pg.screenshot(path=str(HERE / f"shot-{name}-{theme}.png"))
            pg.close()
    b.close()
print("page errors:", errs or "none")
