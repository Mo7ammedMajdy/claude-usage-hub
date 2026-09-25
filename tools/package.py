#!/usr/bin/env python3
"""Build a clean, shareable copy of the hub for someone who runs their own:
dist/claude-usage-hub-kit.zip, from the last commit (never the working tree, never .env files).

    python3 tools/package.py

Leaves out the tools and data, puts kit/ (README, SETUP, HOW-IT-WORKS, CLAUDE.md,
configure.py) at the top, swaps this hub's address for a placeholder that configure.py
replaces, and fails if anything personal is left in it."""
import pathlib, re, shutil, subprocess, sys, tempfile, zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "claude-usage-hub-kit.zip"
OUR_URL = "https://claude-usage-hub.vercel.app"
PLACEHOLDER = "https://YOUR-HUB.vercel.app"
DROP = ("tools/", "kit/", "userscript/test/")
# Anything that must not ship: home paths and this hub's address, plus the words (names, hosts)
# listed one per line in tools/data/private-words.txt, which is local and never committed.
WORDS = ROOT / "tools/data/private-words.txt"
extra = [re.escape(w.strip()) for w in (WORDS.read_text().splitlines() if WORDS.exists() else []) if w.strip()]
PERSONAL = re.compile(r"(?i:/home/|claude-usage-hub\.vercel\.app" + "".join("|" + w for w in extra) + ")")

if subprocess.run(["git", "diff", "--quiet", "HEAD", "--", "kit", "tools/package.py"], cwd=ROOT).returncode:
    sys.exit("kit/ or this script has uncommitted changes: commit them first (the zip is built from HEAD)")

with tempfile.TemporaryDirectory() as tmp:
    stage = pathlib.Path(tmp) / "claude-usage-hub"
    tar = subprocess.run(["git", "archive", "--format=tar", "HEAD"], cwd=ROOT, check=True, capture_output=True).stdout
    stage.mkdir()
    subprocess.run(["tar", "-x", "-C", str(stage)], input=tar, check=True)
    for d in DROP:
        p = stage / d
        shutil.rmtree(p) if p.is_dir() else p.unlink(missing_ok=True)
    for f in (ROOT / "kit").iterdir():
        shutil.copy2(f, stage / f.name)
    # This hub's address → a placeholder that configure.py replaces with theirs.
    for rel in ("collector/setup.sh", "userscript/build.py", "userscript/main.js"):
        f = stage / rel
        f.write_text(f.read_text().replace(OUR_URL, PLACEHOLDER).replace("claude-usage-hub.vercel.app", "YOUR-HUB.vercel.app"))
    subprocess.run([sys.executable, str(stage / "userscript/build.py")], check=True, capture_output=True)
    # The kit's own docs must not be served by Vercel either.
    vi = stage / ".vercelignore"
    vi.write_text(vi.read_text() + "README.md\nCLAUDE.md\nSETUP.md\nHOW-IT-WORKS.md\nconfigure.py\ndist\n")

    leaks = []
    for f in sorted(stage.rglob("*")):
        if f.is_file():
            try:
                t = f.read_text()
            except UnicodeDecodeError:
                continue
            for n, line in enumerate(t.splitlines(), 1):
                # the favicon's base64 can match by chance; long lines of base64 aren't prose
                if len(line) < 2000 and PERSONAL.search(line):
                    leaks.append(f"{f.relative_to(stage)}:{n}: {line.strip()[:120]}")
    if leaks:
        sys.exit("personal details left in the kit:\n" + "\n".join(leaks))

    OUT.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(stage.rglob("*")):
            if f.is_file():
                info = zipfile.ZipInfo.from_file(f, f.relative_to(stage.parent).as_posix())
                z.writestr(info, f.read_bytes(), zipfile.ZIP_DEFLATED)
    n = sum(1 for f in stage.rglob("*") if f.is_file())
print(f"{OUT.relative_to(ROOT)}: {n} files, {OUT.stat().st_size / 1024:.0f} KB")
