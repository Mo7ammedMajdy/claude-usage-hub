import sys, os, time
from playwright.sync_api import sync_playwright
S = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"); tag = sys.argv[1]
K = [l.split("=",1)[1].strip() for l in open(os.path.expanduser("~/.config/claude-usage-sync/env")) if l.startswith("HUB_KEY=")][0]
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/chromium", args=["--remote-debugging-port=0"])
    for w in (1300, 1920, 420):
        pg = b.new_page(viewport={"width": w, "height": 1000}, color_scheme="dark")
        pg.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)
        pg.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
        pg.goto(f"https://claude-usage-hub.vercel.app/#key={K}", wait_until="networkidle")
        pg.wait_for_selector("#app:not([hidden])"); time.sleep(1.5)
        pg.screenshot(path=f"{S}/{tag}-{w}.png", full_page=True)
        if w == 1300:
            pg.click("#ovTab button[data-v=models]"); time.sleep(0.5)
            pg.locator(".row2").screenshot(path=f"{S}/{tag}-models.png")
            pg.click("#tabs button[data-r=week]"); pg.click("#ovTab button[data-v=overview]"); time.sleep(0.5)
            pg.locator("#t_by_platform").screenshot(path=f"{S}/{tag}-week-table.png")
        pg.close()
    b.close()
print("console:", errors or "clean")
