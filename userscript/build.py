#!/usr/bin/env python3
"""Assemble claude-usage.user.js from core.js + main.js. Bump VERSION to push an update:
Violentmonkey checks @updateURL and installs a newer @version by itself."""
import pathlib

VERSION = "1.0.7"
HUB = "https://claude-usage-hub.vercel.app"
HERE = pathlib.Path(__file__).parent

HEADER = f"""// ==UserScript==
// @name         Claude Usage
// @namespace    {HUB}
// @version      {VERSION}
// @description  Context size, what the next message costs, and the shared plan's limits — inside claude.ai.
// @match        https://claude.ai/*
// @match        {HUB}/*
// @run-at       document-start
// @inject-into  auto
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_info
// @connect      claude-usage-hub.vercel.app
// @updateURL    {HUB}/userscript/claude-usage.user.js
// @downloadURL  {HUB}/userscript/claude-usage.user.js
// @noframes
// ==/UserScript==

// Built from userscript/core.js and userscript/main.js by build.py — edit those, not this.
"""

out = HEADER + "\n" + (HERE / "core.js").read_text() + "\n" + (HERE / "main.js").read_text()
(HERE / "claude-usage.user.js").write_text(out)
print(f"claude-usage.user.js {VERSION}: {len(out):,} bytes")
