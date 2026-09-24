#!/usr/bin/env python3
"""Mock claude.ai for testing the fetch hook in Firefox: nonce-only CSP (so page injection is
impossible, as on the real site), a streamed completion shaped like the real one, a
conversation tree, and a /usage response. Results from the page and the hook land in /report."""
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NONCE = "t3stn0nce"
LOG = open(sys.argv[2] if len(sys.argv) > 2 else "report.log", "a", buffering=1)

SHELL = """<link rel="stylesheet" href="/shell.css">"""
SHELL_CSS = """body{margin:0;background:#262624;color:#e8e6dc;font:15px/1.5 system-ui,sans-serif}.col{max-width:760px;margin:0 auto;padding:40px 16px}.bg-surface-3{background:#30302e;border:1px solid #3d3d3a;border-radius:20px;padding:14px 16px}[data-testid=chat-input]{min-height:48px;opacity:.55}.dock{position:relative;padding-bottom:30px}.dock::before{content:'';position:absolute;inset:0;background:#262624;z-index:1}.bg-surface-3{position:relative;z-index:2}.disc{text-align:center;font-size:12px;opacity:.5;margin-top:8px}.modal{position:fixed;z-index:10;inset:40px 60px;background:#1f1e1d;border-radius:14px;display:flex;overflow:auto}.modal nav{width:170px;padding:20px;opacity:.7}.pane{flex:1;padding:24px}.prod{display:flex;justify-content:space-between;max-width:560px}.h{font-weight:600}.lim{display:grid;grid-template-columns:200px 1fr 80px;gap:16px;align-items:center;margin:0 0 36px}.lim p{margin:0}.sub{font-size:12px;opacity:.6}.hl{font-size:22px;font-weight:600;margin:6px 0 18px}.yu{margin:0;font-weight:600}.nbar{height:6px;border-radius:3px;background:#3d3d3a}"""
LIGHT_CSS = ".dock::before{background:#faf9f5}body{background:#faf9f5;color:#141413}.bg-surface-3{background:#fff;border-color:#e5e3da}.modal{background:#fff}"
CHAT = SHELL + """<div class="col"><p>…earlier messages…</p><div class="dock" data-cds-dock-masked><div class="bg-surface-3"><div class="relative w-full min-w-0"><div data-testid="chat-input" contenteditable="true">Write a message…</div></div></div></div><div class="disc">Claude is AI and can make mistakes.</div></div>"""
USAGE = CHAT + """<div role="dialog" class="modal"><nav>Settings · Usage</nav><div class="pane">
<div class="blk"><p class="yu">Your usage <span class="sub">Max (5x)</span></p><h2 class="hl">On track. You should reach tomorrow’s reset with room to spare.</h2></div><div class="blk"><h3>Plan usage limits</h3><div class="lim"><div><p class="lbl">Current session</p><p class="sub">Resets at 6:40 PM</p></div><div class="nbar"><i style="width:18%"></i></div><p>18% used</p></div></div>
<div class="blk"><h3>Weekly limits</h3><div class="lim"><div><p class="lbl">This week</p><p class="sub">Resets Friday 4:00 AM</p></div><div class="nbar"><i style="width:80%"></i></div><p>80% used</p></div>
<div class="lim"><div><p class="lbl">Fable this week</p><p class="sub">Separate weekly limit for Fable · Resets Friday 4:00 AM</p></div><div class="nbar"><i style="width:81%"></i></div><p>81% used</p></div></div>
<div class="blk"><h3>Usage credits</h3><p>Available for any task.</p></div>
<div class="blk"><p class="h">This week’s usage by product</p><div class="prod"><span>Claude Code</span><span>94%</span></div>
<div class="prod"><span>Chats</span><span>6%</span></div><div class="prod"><span>Cowork</span><span>0%</span></div></div>
<div class="blk upd">Last updated: less than a minute ago</div></div></div>"""
PAGE = f"""<!doctype html><title>mock</title><body>{{BODY}}
<script nonce="{NONCE}">
(async () => {{
  // web-ext installs the add-on after this page first loads; reload until the hook is in.
  const n = +(sessionStorage.getItem('n') || 0);
  if (!window.__cuhHooked && n < 25) {{ sessionStorage.setItem('n', n + 1); setTimeout(() => location.reload(), 800); return; }}
  const rep = (who, o) => fetch('/report?who=' + who, {{method: 'POST', body: JSON.stringify(o)}});
  try {{
    // ?late: read the chat around the hook, like the real page does before Violentmonkey is in.
    const turl = '/api/organizations/o1/chat_conversations/11111111-2222-3333-4444-555555555555?tree=True&rendering_mode=messages';
    const tree = location.search.includes('late')
      ? await new Promise((res) => {{ const x = new XMLHttpRequest(); x.open('GET', turl); x.onload = () => res(JSON.parse(x.responseText)); x.send(); }})
      : await fetch(turl).then(r => r.json());
    // Read the stream the way the app does: incrementally, from the body reader.
    const r = await fetch('/api/organizations/o1/chat_conversations/11111111-2222-3333-4444-555555555555/completion', {{method: 'POST', body: '{{}}'}});
    const reader = r.body.getReader(); const dec = new TextDecoder(); let got = '';
    for (;;) {{ const {{done, value}} = await reader.read(); if (done) break; got += dec.decode(value, {{stream: true}}); }}
    const usage = await fetch(new Request('/api/organizations/o1/usage')).then(r => r.json());
    const other = await fetch('/unrelated').then(r => r.text());
    rep('page', {{ok: true, tree_msgs: tree.chat_messages.length, stream_chars: got.length,
                 usage_five: usage.five_hour.utilization, other, fetch_name: fetch.name, reloads: n}});
  }} catch (e) {{ rep('page', {{ok: false, err: String(e)}}); }}
}})();
</script></body>"""

TREE = {
    "uuid": "11111111-2222-3333-4444-555555555555", "model": "claude-opus-5-5", "updated_at": "2026-09-24T13:00:00Z",
    "current_leaf_message_uuid": "m4", "project_uuid": None,
    "chat_messages": [
        {"uuid": "m1", "parent_message_uuid": None, "sender": "human", "content": [{"type": "text", "text": "a" * 370}], "attachments": [{"extracted_content": "b" * 3700}]},
        {"uuid": "m2", "parent_message_uuid": "m1", "sender": "assistant", "content": [{"type": "text", "text": "c" * 740}]},
        {"uuid": "mX", "parent_message_uuid": "m1", "sender": "assistant", "content": [{"type": "text", "text": "z" * 99999}]},  # abandoned branch
        {"uuid": "m3", "parent_message_uuid": "m2", "sender": "human", "content": [{"type": "text", "text": "d" * 37}]},
        {"uuid": "m4", "parent_message_uuid": "m3", "sender": "assistant", "content": [{"type": "text", "text": "e" * 1850}]},
    ],
}

SUMMARY = {"official": {"five": {"pct": 9, "resets_at": "2026-09-24T17:39:00Z"}, "week": {"pct": 79, "resets_at": "2026-09-25T00:59:00Z"},
            "read_at": "2026-09-24T14:00:00Z", "scoped": [{"name": "Fable", "pct": 79, "resets_at": "2026-09-25T00:59:00Z"}]},
            "people": [{"person": "Ahmed", "five": 6.2, "week": 51.3, "fable": 60.1, "calibrated": True, "fable_calibrated": True}, {"person": "Omar", "five": 2.1, "week": 19.4, "fable": 0.4, "calibrated": True, "fable_calibrated": True}],
            "elsewhere": {"five": 0.7, "week": 8.3, "fable": 18.5}, "forecast": {"week": {"pct": 80, "resets_at": "2026-09-25T00:59:00Z", "elapsed_h": 158.4, "projected": 84.7, "runs_out_at": None}, "recent": {"span_h": 24, "per_day": 5.0}, "scoped": []}, "rate": {"a": 0.5, "b": 0.225, "m": {"opus": 1}, "err": 27}, "web": {}}

def rec(event, data):
    body = json.dumps(data)[:-1] + " " * 17 + "}"   # the real stream right-pads its JSON
    return f"event: {event}\ndata: {body}\n\n".encode()

STREAM = [
    rec("message_start", {"type": "message_start", "message": {"uuid": "m5", "model": "claude-opus-5-5", "parent_uuid": "m4"}}),
    rec("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
    rec("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello " * 100}}),
    rec("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "world " * 50}}),
    rec("content_block_stop", {"type": "content_block_stop", "index": 0}),
    rec("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn"}}),
    rec("message_limit", {"type": "message_limit", "message_limit": {
        "type": "within_limit", "overageStatus": "within_limit", "representativeClaim": "five_hour",
        "windows": {"5h": {"status": "within_limit", "resets_at": 1790270000, "utilization": 0.09},
                    "7d": {"status": "within_limit", "resets_at": 1790300000, "utilization": 0.79}}}}),
    rec("message_stop", {"type": "message_stop"}),
]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def send(self, code, body, ctype, extra=()):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        for k, v in extra: self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/chat/") or self.path.startswith("/settings/usage"):
            body = USAGE if self.path.startswith("/settings") else CHAT
            if "light" in self.path: body = body.replace('/shell.css', '/shell.css?light')
            return self.send(200, PAGE.replace("{BODY}", body).encode(), "text/html", [("Content-Security-Policy",
                f"default-src 'self'; script-src 'nonce-{NONCE}'; script-src-attr 'none'; style-src 'self'; connect-src 'self'")])
        if "chat_conversations/11111111-2222-3333-4444-555555555555?tree" in self.path:
            return self.send(200, json.dumps(TREE).encode(), "application/json")
        if self.path.startswith("/api/organizations/o1/usage"):
            return self.send(200, json.dumps({"five_hour": {"utilization": 9.0, "resets_at": "2026-09-24T15:39:00Z"},
                                              "seven_day": {"utilization": 79.0, "resets_at": "2026-09-25T00:59:00Z"}}).encode(), "application/json")
        if self.path.startswith("/shell.css"):
            return self.send(200, (SHELL_CSS + (LIGHT_CSS if "light" in self.path else "")).encode(), "text/css")
        if self.path.startswith("/hub/api/summary"):
            return self.send(200, json.dumps(SUMMARY).encode(), "application/json")
        if self.path == "/unrelated":
            return self.send(200, b"still-works", "text/plain")
        self.send(404, b"", "text/plain")

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        if self.path.startswith("/hub/api/web"):
            LOG.write(f"hubpost\t{body.decode()}\n")
            return self.send(200, b'{"ok":true}', "application/json")
        if self.path.startswith("/report"):
            LOG.write(f"{self.path.split('who=')[-1]}\t{body.decode()}\n")
            return self.send(204, b"", "text/plain")
        if self.path.endswith("/completion"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for chunk in STREAM:          # arrive in bursts, like the real thing
                self.wfile.write(chunk); self.wfile.flush(); time.sleep(0.05)
            return
        self.send(404, b"", "text/plain")


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
