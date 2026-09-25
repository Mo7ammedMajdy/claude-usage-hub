#!/usr/bin/env python3
"""Point this copy of the hub at its own address, then rebuild the userscript.

    python3 configure.py https://<your-project>.vercel.app

The dashboard and the API find their address by themselves. Three files name it outright:
setup.sh (its default hub), and the userscript (its HUB constant and its @connect line).
Run this again with a new address whenever the address changes."""
import pathlib, re, subprocess, sys, urllib.parse

# At the top of the shareable zip, or in kit/ of the git repo: the hub's files sit beside it or one up.
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE if (HERE / "collector/setup.sh").exists() else HERE.parent
if len(sys.argv) != 2:
    sys.exit(__doc__)
url = sys.argv[1].strip().rstrip("/")
u = urllib.parse.urlparse(url)
if u.scheme != "https" or not u.netloc or u.path or u.query or u.fragment:
    sys.exit("give the hub's plain https address, e.g. https://my-usage-hub.vercel.app")

EDITS = [
    ("collector/setup.sh", r'HUB="\$\{HUB_URL:-https://[^}]*\}"', f'HUB="${{HUB_URL:-{url}}}"'),
    ("collector/setup.sh", r"curl -fsSL https://\S+/collector/setup\.sh", f"curl -fsSL {url}/collector/setup.sh"),
    ("userscript/build.py", r'HUB = "https://[^"]*"', f'HUB = "{url}"'),
    ("userscript/build.py", r"// @connect      \S+", f"// @connect      {u.netloc}"),
    ("userscript/main.js", r'const HUB = "https://[^"]*";', f'const HUB = "{url}";'),
]
for rel, pattern, new in EDITS:
    f = ROOT / rel
    text = f.read_text()
    text, n = re.subn(pattern, lambda _m: new, text)
    if n == 0:
        sys.exit(f"{rel}: didn't find the hub address to replace ({pattern})")
    f.write_text(text)
    print(f"{rel}: {n} place{'s' if n > 1 else ''} now point at {url}", flush=True)
subprocess.run([sys.executable, str(ROOT / "userscript/build.py")], check=True)
