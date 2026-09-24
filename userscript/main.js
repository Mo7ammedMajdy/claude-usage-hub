// Userscript runtime: hooks the page (core.js), keeps a little state, draws two things, and
// forwards readings to the hub.
//
//   * under the message box, on every chat: context size, what the next message will cost,
//     the cache countdown, and the plan limits — one quiet line
//   * on claude.ai/settings/usage: a "Shared account" card with each person's share
//
// Reading is passive — copies of responses the page fetched anyway — with one exception: when
// the hook missed the page's first read of the open chat, it reads that chat once itself.
//
// The hub key is picked up from the dashboard (open it once while logged in there), so there
// is nothing to paste.

/* global cuhInstall, cuhTokens, GM_xmlhttpRequest, GM_getValue, GM_setValue, GM_registerMenuCommand */

const HUB = "https://claude-usage-hub.vercel.app";
const CACHE_TTL_MS = 5 * 60e3;      // claude.ai's prompt cache lives about five minutes

// What the diagnostics panel shows. The script must never fail silently: claude.ai changes its
// page without notice, and "nothing appeared" is the one report nobody can act on.
const diag = { mode: "?", hooked: false, events: {}, hub: "not tried", composer: "not looked", errors: [] };
const oops = (where, e) => { diag.errors.push(`${where}: ${(e && e.message) || e}`.slice(0, 200)); if (diag.errors.length > 5) diag.errors.shift(); };

// ---------------------------------------------------------------- key, on the dashboard
if (location.host === new URL(HUB).host) {
  const grab = () => {
    try {
      const k = localStorage.getItem("hubKey");
      if (k && k !== GM_getValue("hubKey")) GM_setValue("hubKey", k);
    } catch (e) { /* storage blocked */ }
  };
  grab();
  window.addEventListener("load", grab);
  setInterval(grab, 5000);       // also catches a login done after the page opened
} else {
  try { claudePage(); } catch (e) { oops("startup", e); console.error("[claude-usage]", e); }
}

function claudePage() {
  // API $ per 1M tokens (input, output, cache read), as in the collector (see the source there).
  const PRICES = [
    ["claude-fable-5-1", [10, 50, 0.25]], ["claude-mythos-5-1", [10, 50, 0.25]], ["claude-fable", [10, 50, 1]],
    ["claude-mythos", [10, 50, 1]], ["claude-opus-5-5", [4, 20, 0.2]], ["claude-opus-4-1", [15, 75, 1.5]],
    ["claude-opus-4-2025", [15, 75, 1.5]], ["claude-opus", [5, 25, 0.5]], ["claude-sonnet-5", [2, 10, 0.2]],
    ["claude-sonnet", [3, 15, 0.3]], ["claude-3-5-haiku", [0.8, 4, 0.08]], ["claude-haiku", [1, 5, 0.1]],
  ];
  const price = (m) => (PRICES.find(([p]) => (m || "").startsWith(p)) || [0, [5, 25, 0.5]])[1];
  const family = (m) => /fable|mythos/.test(m) ? "fable" : /opus/.test(m) ? "opus" : /sonnet/.test(m) ? "sonnet" : /haiku/.test(m) ? "haiku" : "other";

  const st = {
    convs: new Map(),          // conv id -> { tokens, messages, model, reply, lastMsg }
    limits: null,              // newest { five, week, t } seen on this page
    summary: null,             // /api/summary
    queue: [],
  };
  const convId = () => (location.pathname.match(/\/chat\/([0-9a-f-]{36})/) || [])[1] || null;

  // ------------------------------------------------------------ hook
  // Firefox runs us as a content script (claude.ai's CSP blocks page injection): reach the page
  // through wrappedJSObject and export what it calls. Chromium managers inject into the page.
  // Violentmonkey's content-mode sandbox hands us a proxied `window` without wrappedJSObject;
  // its unsafeWindow is the content script's real window, whose wrappedJSObject is the page.
  const uw = typeof unsafeWindow === "object" ? unsafeWindow : null;
  const waived = (uw && uw.wrappedJSObject) || window.wrappedJSObject || null;
  const page = waived || uw || window;
  const exporting = !!waived && typeof exportFunction === "function";
  diag.mode = waived ? (exporting ? "content (Firefox, exported)" : "content, no exportFunction") : uw ? "page (unsafeWindow)" : "page";
  try { diag.hooked = cuhInstall(page, exporting, onEvent) || !!page.__cuhHooked; } catch (e) { oops("hook", e); }

  function onEvent(ev) {
    diag.events[ev.kind] = (diag.events[ev.kind] || 0) + 1;
    if (ev.org) st.org = ev.org;
    const c = st.convs.get(ev.conv) || {};
    if (ev.kind === "conversation") {
      Object.assign(c, { tokens: ev.tokens, messages: ev.messages, model: ev.model || c.model });
      // The tree has no per-message cost, but its last timestamp tells us how warm the cache is.
      if (ev.updated_at) c.lastMsg = Math.max(c.lastMsg || 0, Date.parse(ev.updated_at) || 0);
    } else if (ev.kind === "completion") {
      ev.ctx_tokens = c.tokens ?? null;
      ev.reply_tokens = cuhTokens(ev.reply_chars);
      Object.assign(c, { model: ev.model || c.model, reply: ev.reply_tokens, lastMsg: Date.now() });
      if (c.tokens != null) c.tokens += ev.reply_tokens;   // the page refetches the tree right after
      if (ev.limits) st.limits = { ...ev.limits, t: Date.now() };
      setTimeout(refreshSummary, 20e3);                     // collectors sync; pick the new split up
    } else if (ev.kind === "usage") {
      st.limits = { five: ev.five, week: ev.week, t: Date.now() };
    }
    if (ev.conv) st.convs.set(ev.conv, c);
    if (ev.kind !== "usage") { st.queue.push(ev); if (st.queue.length > 200) st.queue.shift(); }
    if (ev.kind === "completion") flush();
    schedule();
  }

  // ------------------------------------------------------------ one read per chat
  // In Firefox the page asks for the open chat ~170 ms into loading, usually before the hook is
  // in, and it serves chats it has already loaded from its own cache. When that happened, read
  // the chat once ourselves: the page's own request, through the page's own fetch (so the hook
  // parses it like any other), once per chat per page load, only for the chat on screen.
  // Chosen over waiting for the next message.
  const readOnce = new Set();
  let viewing = { conv: null, since: 0 };
  const orgId = () => st.org || (performance.getEntriesByType("resource").map((e) => e.name)
    .map((u) => (u.match(/\/api\/organizations\/([0-9a-f-]{36})\//) || [])[1]).find(Boolean)) || null;
  function maybeReadOnce() {
    const conv = convId();
    if (conv !== viewing.conv) { viewing = { conv, since: Date.now() }; return; }
    const c = conv && st.convs.get(conv);
    if (!conv || (c && c.tokens != null) || readOnce.has(conv) || document.hidden || !diag.hooked) return;
    if (Date.now() - viewing.since < 2500) return;          // give the page's own read a chance
    const org = orgId();
    if (!org) return;
    readOnce.add(conv);
    diag.readOnce = (diag.readOnce || 0) + 1;
    try { page.fetch(`/api/organizations/${org}/chat_conversations/${conv}?tree=True&rendering_mode=messages&render_all_tools=true`); }
    catch (e) { oops("read once", e); }
  }

  // ------------------------------------------------------------ hub
  function hub(method, path, body) {
    const key = GM_getValue("hubKey");
    if (!key) { diag.hub = "no key yet — open the dashboard once in this browser"; return Promise.resolve(null); }
    return new Promise((resolve) => GM_xmlhttpRequest({
      method, url: HUB + path, timeout: 15000,
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      data: body ? JSON.stringify(body) : undefined,
      onload: (r) => {
        diag.hub = r.status === 200 ? "ok" : r.status === 401 ? "401: the stored key is wrong — open the dashboard with your key link" : "HTTP " + r.status;
        try { resolve(r.status === 200 ? JSON.parse(r.responseText) : null); } catch (e) { resolve(null); }
      },
      onerror: () => { diag.hub = "network error"; resolve(null); }, ontimeout: () => { diag.hub = "timeout"; resolve(null); },
    }));
  }
  async function flush() {
    if (!st.queue.length || !GM_getValue("hubKey")) return;
    const batch = st.queue.splice(0);
    const ok = await hub("POST", "/api/web", { browser: navigator.userAgent.includes("Firefox") ? "firefox" : "chromium", events: batch });
    if (!ok) st.queue.unshift(...batch.slice(-150));      // keep it for the next try
  }
  async function refreshSummary() {
    const s = await hub("GET", "/api/summary");
    if (s) { st.summary = s; st.summaryAt = Date.now(); schedule(); }
  }
  setInterval(flush, 15e3);
  // Only the tab being looked at keeps the split fresh (every hub read costs Redis commands, and
  // claude.ai tends to stay open in several tabs); a tab coming back into view catches up.
  const stale = () => Date.now() - (st.summaryAt || 0) > 5 * 60e3;
  setInterval(() => document.visibilityState === "visible" && stale() && refreshSummary(), 30e3);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && stale() && refreshSummary());

  // ------------------------------------------------------------ numbers
  const fmtTok = (n) => n == null ? "–" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
  // Hub numbers go into innerHTML, so anything that isn't a finite number becomes "–".
  const num = (v) => v == null || v === "" || !Number.isFinite(+v) ? null : +v;
  const approx = (v) => num(v) == null ? "–" : num(v) < 0.1 ? "<0.1%" : "≈" + pctStr(v);
  const pctStr = (v) => (v = num(v)) == null ? "–" : v < 0.1 ? "<0.1%" : v < 10 ? v.toFixed(1) + "%" : Math.round(v) + "%";
  const limitsNow = () => {
    const off = st.summary && st.summary.official;
    const fromHub = off && { five: off.five, week: off.week, t: Date.parse(off.read_at) || 0 };
    return !st.limits ? fromHub : !fromHub ? st.limits : st.limits.t >= fromHub.t ? st.limits : fromHub;
  };

  /** % of the 5-hour session the next message in this chat should cost, and whether that
   *  assumes a warm cache. Uses the rate the hub has learned; null until it has one. */
  function nextCost(c) {
    const rate = st.summary && st.summary.rate;
    if (!rate || !c || c.tokens == null) return null;
    const [inp, out, cr] = price(c.model);
    const warm = c.lastMsg && Date.now() - c.lastMsg < CACHE_TTL_MS;
    const reply = c.reply || 400;
    // Warm: the history is a cache read. Cold: it is written to the cache again (1.25x input).
    const x = ((warm ? 0 : c.tokens * inp * 1.25) + reply * out + 150 * inp) / 1e6;
    const r = warm ? (c.tokens * cr) / 1e6 : 0;
    const w = (rate.m && rate.m[family(c.model || "")]) ?? 1;
    return { pct: w * (rate.a * x + rate.b * r), warm, left: warm ? CACHE_TTL_MS - (Date.now() - c.lastMsg) : 0 };
  }

  // ------------------------------------------------------------ drawing
  const CSS = `
    :host { all: initial; display: block; font: inherit; color: inherit; }
    .line { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 14px; font-size: 12px; line-height: 18px;
            padding: 2px calc(var(--cmp-pad-x, .5rem) + 8px) 8px; font-variant-numeric: tabular-nums; }
    .it { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    /* A colour, not an opacity: opacities multiply when nested, and that took labels below 4:1. */
    .k { color: color-mix(in srgb, currentColor 70%, transparent); }
    .bar { width: 44px; height: 4px; border-radius: 2px; background: color-mix(in srgb, currentColor 18%, transparent); overflow: hidden; }
    .bar > i { display: block; height: 100%; background: #2a78d6; border-radius: 2px; }
    .warn .bar > i { background: #e8a92a; } .hot .bar > i { background: #e5484d; }
    /* Text is mixed about half-way toward the text colour: pure amber on white is ~2:1, and this
       keeps every one ≥5:1 on both claude.ai themes. The bar fills above stay the pure colour. */
    .warn { color: color-mix(in srgb, #e8a92a 55%, currentColor); } .hot { color: color-mix(in srgb, #e5484d 60%, currentColor); }
    .warm { color: color-mix(in srgb, #36a88f 60%, currentColor); }
    .sp { flex: 1; }
    a { color: inherit; text-decoration: none; opacity: .8; } a:hover { opacity: 1; text-decoration: underline; }
    .float { position: fixed; right: 16px; bottom: 12px; z-index: 50; border-radius: 10px; padding: 8px 12px;
             background: var(--cuh-bg, #262624); color: var(--cuh-fg, #e8e6dc);
             border: 1px solid color-mix(in srgb, currentColor 14%, transparent); box-shadow: 0 2px 10px rgba(0,0,0,.3); }
    .muted { opacity: .6; }
    /* the who-used-what line under claude.ai's own usage bars */
    .split { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 16px; font-size: 12.5px; line-height: 18px;
             opacity: .85; font-variant-numeric: tabular-nums; }
    .split b { font-weight: 600; }
    .fc { font-size: 14px; line-height: 20px; margin: 6px 0 2px; }
    .fc .muted { font-size: 12.5px; line-height: 18px; margin-top: 2px; opacity: .65; }
    .cd { opacity: .75; white-space: nowrap; }
    .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; }
    .diag { max-width: 460px; font-size: 12px; line-height: 17px; opacity: 1; cursor: default; }
    .diag table { border-collapse: collapse; margin: 6px 0; } .diag td { padding: 2px 10px 2px 0; vertical-align: top; }
    .diag td:first-child { opacity: .6; white-space: nowrap; } .diag .x { cursor: pointer; }
  `;
  const COLORS = ["#36a88f", "#b39ceb", "#8fb562", "#8ba0b8"];   // the dashboard's --c1..--c4
  const colorOf = (name) => {
    const people = ((st.summary && st.summary.people) || []).map((p) => p.person).sort();
    return COLORS[Math.max(0, people.indexOf(name)) % COLORS.length];
  };

  // claude.ai's dark theme doesn't redefine the system colours, so "Canvas" stays white. Take
  // the page's actual background and text colour for anything that floats over it.
  function pageColours(el) {
    const solid = (c) => c && c !== "transparent" && !/rgba\(.*,\s*0\)$/.test(c);
    let bg = null;
    for (const n of [document.body, document.documentElement]) {
      const c = n && getComputedStyle(n).backgroundColor;
      if (solid(c)) { bg = c; break; }
    }
    const fg = getComputedStyle(document.body).color;
    if (bg) el.style.setProperty("--cuh-bg", bg);
    if (fg) el.style.setProperty("--cuh-fg", fg);
  }
  function host(id) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      const shadow = el.attachShadow({ mode: "open" });
      // A constructed stylesheet isn't an inline style, so it survives a CSP without
      // 'unsafe-inline'; fall back to a <style> element where adopting isn't allowed.
      try {
        if (!host.sheet) { host.sheet = new CSSStyleSheet(); host.sheet.replaceSync(CSS); }   // one sheet, shared
        shadow.adoptedStyleSheets = [host.sheet];
        shadow.innerHTML = `<div class="root"></div>`;
      } catch (e) {
        shadow.innerHTML = `<style>${CSS}</style><div class="root"></div>`;
      }
    }
    return el;
  }
  function paint(root, html) {
    if (root.__cuhHtml === html) return;       // unchanged: leave the DOM alone
    root.__cuhHtml = html;
    root.innerHTML = html;
    for (const i of root.querySelectorAll("[data-w]")) i.style.width = i.dataset.w + "%";
    for (const d of root.querySelectorAll("[data-c]")) d.style.background = d.dataset.c;
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const INPUTS = ['[data-testid="chat-input"]', 'div.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]', 'fieldset [contenteditable="true"]', 'fieldset textarea'];
  const findInput = () => { for (const q of INPUTS) { const el = document.querySelector(q); if (el) return [el, q]; } return [null, null]; };
  function composerAnchor() {
    const [input, how] = findInput();
    if (!input) { diag.composer = "no message box found (" + INPUTS.length + " selectors tried)"; return null; }
    // The rounded message box: the redesign calls it bg-surface-3; otherwise the nearest
    // ancestor that is visibly a card. Mount right after it, so it never sits inside the input.
    let box = input.closest(".bg-surface-3");
    for (let el = input.parentElement; !box && el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (parseFloat(cs.borderTopLeftRadius) >= 12 && (cs.backgroundColor !== "rgba(0, 0, 0, 0)" || parseFloat(cs.borderTopWidth) > 0)) box = el;
    }
    diag.composer = box ? `found via ${how}` : `input via ${how}, but no box around it`;
    return box;
  }


  function drawLine() {
    const conv = convId();
    const el = host("cuh-line");
    const box = composerAnchor();
    const onChatPage = !!box || !!conv || /^\/(new|chat|project)/.test(location.pathname);
    if (!onChatPage) { el.remove(); return; }
    const root = el.shadowRoot.querySelector(".root");
    if (box) {
      // Inside the rounded box, as its last row. Below the box looks the same on the new-chat
      // page, but in a conversation the composer sits in a masked dock that paints anything
      // under the box invisible (2026-09-24) — it's there, it just can't be seen.
      if (el.parentElement !== box || box.lastElementChild !== el) box.appendChild(el);
      root.classList.remove("float");
    } else if (el.parentElement !== document.body) {
      document.body.appendChild(el);
      root.classList.add("float");
      pageColours(el);
    }

    const c = conv && st.convs.get(conv);
    const lim = limitsNow();
    const parts = [];
    if (c && c.tokens != null) {
      const cls = c.tokens > 150e3 ? "hot" : c.tokens > 80e3 ? "warn" : "";
      parts.push(`<span class="it ${cls}" title="Estimated from the visible text (Claude's tokenizer isn't public). Thinking and tool results aren't visible to the page, so the real context is somewhat larger."><span class="k">Context</span> ≈${fmtTok(c.tokens)}</span>`);
      const nc = nextCost(c);
      if (nc) {
        parts.push(`<span class="it" title="What sending one more message here should use, from the rate the hub has learned (±${num(st.summary.rate.err) ?? "?"}%). ${nc.warm ? "The cache is warm, so the history is re-read cheaply." : "The cache has expired, so the whole history is written again."}"><span class="k">Next message</span> ${approx(nc.pct)}</span>`);
        parts.push(nc.warm
          ? `<span class="it warm" title="Send before this runs out and the history is re-read at the cache price.">cached ${Math.floor(nc.left / 60e3)}:${String(Math.floor(nc.left / 1e3) % 60).padStart(2, "0")}</span>`
          : `<span class="it muted" title="No message in the last five minutes: the next one pays full price for the history.">cache cold</span>`);
      } else if (!GM_getValue("hubKey")) {
        parts.push(`<a class="it" href="${HUB}" target="_blank" title="Open the dashboard once, logged in, and this picks up your key.">connect to hub</a>`);
      }
    } else if (conv) {
      parts.push(`<span class="it muted">measuring chat…</span>`);
    }
    parts.push(`<span class="sp"></span>`);
    const barItem = (label, v) => {
      const pct = v && num(v.pct) != null ? Math.round(num(v.pct)) : null;   // from the hub: never raw
      if (pct == null) return "";
      const cls = pct >= 90 ? "hot" : pct >= 75 ? "warn" : "";
      return `<span class="it ${cls}"><span class="k">${label}</span><span class="bar"><i data-w="${Math.max(0, Math.min(100, pct))}"></i></span>${pct}%</span>`;
    };
    if (lim) parts.push(barItem("Session", lim.five), barItem("Week", lim.week));
    paint(root, `<div class="line">${parts.join("")}</div>`);
  }

  // Text an element holds itself, not its children's: finds the node that owns a sentence even
  // after we've appended our own span into it.
  const ownText = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.data).join("").trim();
  const holding = (root, re) => root && [...root.querySelectorAll("*")].find((n) => re.test(ownText(n)));
  const dayClock = (iso) => {
    const d = new Date(iso), day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
    const diff = Math.round((day(d) - day(new Date())) / 864e5);
    const clock = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `${diff === 0 ? "today" : diff === 1 ? "tomorrow" : d.toLocaleDateString([], { weekday: "long" })} ${clock}`;
  };
  const countdown = (iso, short) => {
    const m = Math.round((Date.parse(iso) - Date.now()) / 6e4);
    if (!(m > 0)) return "now";
    const h = Math.floor(m / 60), r = m % 60;
    return short ? `in ${h ? h + "h " : ""}${r}m` : `in ${h ? h + " h " : ""}${r} min`;
  };

  // The dashboard's forecast, under claude.ai's own headline: its "On track" has no number.
  function drawForecast(anchorRow) {
    const el = host("cuh-forecast");
    const f = st.summary && st.summary.forecast;
    const pane = anchorRow && (anchorRow.closest('[role="dialog"]') || document.body);
    const headline = holding(pane, /^(on track|heads up|you['’](re|ve|ll)|at this pace)/i);
    if (!f || !f.week || !headline) { el.remove(); return; }
    if (el.previousElementSibling !== headline) headline.after(el);
    const w = f.week, days = w.elapsed_h / 24, g = f.pattern;
    if (g && !g.early && g.expected != null) {
      // The hub's pattern forecast (recent pace + the last 7 days replayed), as on the dashboard.
      const r = (v) => Math.round(num(v) ?? 0);
      // Never "a 0% chance": a range of futures can't rule it out, so small ones read "<5%".
      const chance = (p) => p < 0.05 ? "less than a 5%" : `about a ${r(p * 100)}%`;
      const lead2 = g.runs_out_at ? `At the recent pace you'll hit the limit ${dayClock(g.runs_out_at)}, before the reset.`
        : num(g.p_limit) >= 0.15 ? `Probably fine, but a busy day could do it: ${chance(num(g.p_limit))} chance of hitting the limit before the reset.`
        : `You'll likely end the week around ${r(g.expected)}% when it resets ${dayClock(g.resets_at)}.`;
      const more2 = `Likely ${r(g.lo)}–${r(g.hi)}%. Recent pace: ${(num(g.per_day_recent) ?? 0).toFixed(1)}% a day; ` +
        (g.left_h < 24 ? `${r(100 - num(g.pct))}% is left for the last ${Math.max(1, r(g.left_h))} h.` : `you can use up to ${r(g.budget_per_day)}% a day and still reach the reset.`);
      paint(el.shadowRoot.querySelector(".root"), `<div class="fc"><div>${esc(lead2)}</div><div class="muted">${esc(more2)}</div></div>`);
      return;
    }
    const lead = w.projected == null
      ? `A new week started ${w.elapsed_h < 1 ? "less than an hour" : Math.round(w.elapsed_h) + " h"} ago: ${Math.round(w.pct)}% used so far.`
      : w.runs_out_at
      ? `At this pace you'll run out ${dayClock(w.runs_out_at)}, before the reset.`
      : `At this pace you'll have used about ${Math.min(99, Math.round(w.projected))}% of the week when it resets ${dayClock(w.resets_at)}.`;
    let more = `Average pace so far: ${Math.round(w.pct)}% in ${days < 1 ? Math.round(w.elapsed_h) + " h" : days.toFixed(1) + " days"}.`;
    if (f.recent) more += ` Over the last ${Math.round(num(f.recent.span_h) ?? 0)} h: about ${(num(f.recent.per_day) ?? 0).toFixed(1)}% per day.`;
    for (const x of f.scoped || []) more += ` ${x.name}'s separate limit runs out sooner, ${dayClock(x.runs_out_at)}.`;
    paint(el.shadowRoot.querySelector(".root"), `<div class="fc"><div>${esc(lead)}</div><div class="muted">${esc(more)}</div></div>`);
  }

  // "· in 9 h 24 min" after each native reset time — shortened if the full form would wrap the
  // label onto another line, so the rows keep their height.
  function drawCountdown(key, row, iso) {
    const el = host("cuh-cd-" + key);
    const leaf = row && iso && holding(row, /resets/i);
    if (!leaf) { el.remove(); return; }
    if (el.parentElement !== leaf) { leaf.dataset.cuhH = leaf.getBoundingClientRect().height; leaf.appendChild(el); }
    el.style.display = "inline";
    const root = el.shadowRoot.querySelector(".root");
    root.style.display = "inline";       // a block inside the line would force a break
    paint(root, `<span class="cd"> · ${countdown(iso, false)}</span>`);
    if (leaf.getBoundingClientRect().height > +leaf.dataset.cuhH + 2) paint(root, `<span class="cd"> · ${countdown(iso, true)}</span>`);
  }

  // Finding claude.ai's own usage rows by what they say; its class names are generated.
  const leafMatching = (re) => [...document.querySelectorAll("p,span,div,h2,h3,h4,label")]
    .find((n) => n.childElementCount === 0 && re.test((n.textContent || "").trim()));
  function nativeRow(re) {
    const leaf = leafMatching(re);
    if (!leaf) return null;
    const pcts = (n) => ((n.textContent || "").match(/\d+\s*%/g) || []).length;
    let row = leaf;
    while (row.parentElement && !pcts(row)) row = row.parentElement;          // reach its "18% used"
    if (!pcts(row)) return null;
    // Widen to the whole row, but never enough to take in the next limit's percentage.
    while (row.parentElement && row.parentElement !== document.body && row.parentElement.getAttribute("role") !== "dialog"
      && pcts(row.parentElement) === pcts(row)) row = row.parentElement;
    return row;
  }
  function shares(key) {
    const s = st.summary;
    if (!GM_getValue("hubKey")) return `<span class="muted">Open <a href="${HUB}" target="_blank">the dashboard</a> once to see who used what</span>`;
    if (!s || !s.official) return `<span class="muted">who used what: loading…</span>`;
    const ok = (p) => key === "fable" ? p.fable_calibrated : p.calibrated;
    const out = [...(s.people || [])].sort((a, b) => a.person.localeCompare(b.person))
      .map((p) => `<span><span class="dot" data-c="${colorOf(p.person)}"></span>${esc(p.person)} <b>${ok(p) ? pctStr(p[key]) : "…"}</b></span>`);
    const e = s.elsewhere && s.elsewhere[key];
    if (e != null) out.push(`<span class="muted" title="Usage no synced laptop logged: the phone, other devices, and claude.ai chats until those are calibrated.">not synced ${pctStr(e)}</span>`);
    return out.join("");
  }

  // The thin track of a native usage bar: the widest element in the row that is only a few
  // pixels tall. Measured, not selected by class, because the class names are generated.
  function trackOf(row) {
    let best = null, bw = 0;
    for (const n of row.querySelectorAll("div,span,progress,[role=progressbar]")) {
      const r = n.getBoundingClientRect();
      if (r.height >= 2 && r.height <= 14 && r.width > bw && r.width > 80) { best = n; bw = r.width; }
    }
    return best;
  }
  // Lay `el` over the empty space under the row's bar. Absolutely positioned inside the row, so
  // claude.ai's layout doesn't move at all; the row only gets position:relative if it had none.
  function overlay(el, row, place) {
    if (el.parentElement !== row) row.appendChild(el);
    if (getComputedStyle(row).position === "static") row.style.position = "relative";
    const rr = row.getBoundingClientRect(), track = trackOf(row);
    const box = place === "below-row" || !track
      ? { left: 0, top: rr.height + 12, width: rr.width }
      : (() => { const t = track.getBoundingClientRect(); // Out to the row's right edge, not just the bar's width: the bar is narrow at ~900 px
      // and the split wrapped onto three lines, into the next heading.
      return { left: t.left - rr.left, top: t.bottom - rr.top + 9, width: rr.right - t.left }; })();
    Object.assign(el.style, { position: "absolute", left: box.left + "px", top: box.top + "px", width: box.width + "px", margin: "0" });
  }

  // claude.ai's own usage page already draws the totals. All this adds is *who*: each person's
  // share laid under its "Current session", "This week" and "Fable this week" bars, and a
  // dashboard link under the three. If those rows can't be found, the lines go after the
  // product table instead, as plain rows.
  const OURS_ON_USAGE = ["cuh-split-five", "cuh-split-week", "cuh-split-fable", "cuh-dash-link", "cuh-forecast", "cuh-cd-five", "cuh-cd-week", "cuh-cd-fable"];
  function drawUsageCard() {
    // Only the settings page has the usage rows; anywhere else, don't search the page at all
    // (this runs on every redraw, and a streaming reply redraws often).
    if (!/settings/.test(location.pathname + location.hash)) {
      for (const id of OURS_ON_USAGE) { const x = document.getElementById(id); if (x) x.remove(); }
      return;
    }
    const ids = { five: "cuh-split-five", week: "cuh-split-week", fable: "cuh-split-fable" };
    const lines = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, host(id)]));
    const link = host("cuh-dash-link");
    const products = leafMatching(/usage by product/i);
    const rows = { five: nativeRow(/^current session$/i), week: nativeRow(/^this week$/i) || nativeRow(/^all models$/i),
                   fable: nativeRow(/^fable( this week)?$/i) };
    if (!products && !rows.five) {
      for (const id of ["cuh-forecast", "cuh-cd-five", "cuh-cd-week", "cuh-cd-fable"]) { const x = document.getElementById(id); if (x) x.remove(); }
      for (const el of [...Object.values(lines), link]) el.remove();
      return;
    }
    const updated = st.summary && st.summary.official ? num(Math.max(0, Math.round((Date.now() - Date.parse(st.summary.official.read_at)) / 6e4))) : null;
    const tip = `Estimated from each person's own logs${updated == null ? "" : `, updated ${updated} min ago`}.`;
    const native = rows.five && rows.week;

    let prev = null;             // fallback: plain rows after the product table
    if (!native) {
      prev = products;
      const OTHER = /last updated|usage credits|monthly spend|buy more usage/i;
      while (prev && prev.parentElement && prev.parentElement !== document.body && prev.parentElement.getAttribute("role") !== "dialog"
        && !OTHER.test(prev.parentElement.textContent || "")) prev = prev.parentElement;
    }
    for (const key of ["five", "week", "fable"]) {
      const el = lines[key];
      if (native) {
        if (!rows[key]) { el.remove(); continue; }
        overlay(el, rows[key]);
      } else {
        if (!prev) { el.remove(); continue; }
        if (el.previousElementSibling !== prev) prev.after(el);
        el.style.position = "";
        prev = el;
      }
      const label = native ? "" : `<span class="k">${{ five: "Session", week: "Week", fable: "Fable" }[key]}</span>`;
      paint(el.shadowRoot.querySelector(".root"), `<div class="split" title="${esc(tip)}">${label}${shares(key)}</div>`);
    }
    const off = st.summary && st.summary.official;
    const fableLim = off && (off.scoped || []).find((x) => /fable/i.test(x.name));
    drawCountdown("five", native && rows.five, off && off.five && (off.five.resets_exact || off.five.resets_at));
    drawCountdown("week", native && rows.week, off && off.week && (off.week.resets_exact || off.week.resets_at));
    drawCountdown("fable", native && rows.fable, fableLim && (fableLim.resets_exact || fableLim.resets_at));
    drawForecast(native && rows.five);
    // The link sits under all three, in the gap claude.ai already leaves before the next box.
    const last = native ? (rows.fable || rows.week) : prev;
    if (!last) { link.remove(); return; }
    if (native) overlay(link, last, "below-row"); else if (link.previousElementSibling !== last) last.after(link);
    paint(link.shadowRoot.querySelector(".root"), `<div class="split"><a class="muted" href="${HUB}" target="_blank" title="${esc(tip)}">Open the full usage dashboard →</a></div>`);
  }



  let showDiag = false;
  try { GM_registerMenuCommand("Diagnostics", () => { showDiag = !showDiag; schedule(); }); } catch (e) { /* not granted */ }
  function drawDiag() {
    const problems = [];
    if (!diag.hooked) problems.push("the fetch hook isn't installed, so nothing from claude.ai is being read");
    if (/^no message box|but no box/.test(diag.composer) && /^\/(new|chat|project)/.test(location.pathname)) problems.push("can't find the message box: " + diag.composer);
    if (diag.hub !== "ok" && diag.hub !== "not tried") problems.push("hub: " + diag.hub);
    if (diag.errors.length) problems.push("errors: " + diag.errors.join(" | "));
    if (!problems.length && !showDiag) { const x = document.getElementById("cuh-diag"); if (x) x.remove(); return; }
    const el = host("cuh-diag");
    if (el.parentElement !== document.body) document.body.appendChild(el);
    pageColours(el);
    const root = el.shadowRoot.querySelector(".root");
    const open = showDiag || el.dataset.open === "1";
    const rows = [
      ["script", "running, v" + (typeof GM_info === "object" ? GM_info.script.version : "?")],
      ["mode", diag.mode], ["hook", diag.hooked ? "installed" : "NOT installed"],
      ["events seen", Object.entries(diag.events).map(([k, v]) => `${k} ${v}`).join(", ") || "none yet — open or send a message"],
      ["message box", diag.composer], ["chats read once", String(diag.readOnce || 0)], ["hub", diag.hub], ["errors", diag.errors.join(" | ") || "none"],
    ];
    paint(root, `<div class="float diag">${open
      ? `<b>Claude Usage — diagnostics</b><table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join("")}</table><a class="x">close</a>`
      : `<a class="x">⚠ Claude Usage: ${esc(problems[0])}</a>`}</div>`);
    root.querySelector(".x").onclick = () => { el.dataset.open = open ? "0" : "1"; showDiag = false; schedule(); };
  }

  // Redraw on page changes, at most every 250 ms (a streaming reply changes the page thousands
  // of times a second), and on a 1 s tick for the cache countdown.
  let pending = false, lastDraw = 0;
  function schedule() {
    if (pending) return;
    pending = true;
    const run = () => window.requestAnimationFrame(() => {
      pending = false; lastDraw = Date.now();
      for (const f of [maybeReadOnce, drawLine, drawUsageCard, drawDiag]) { try { f(); } catch (e) { oops(f.name, e); } }
    });
    const wait = 250 - (Date.now() - lastDraw);
    if (wait > 0) setTimeout(run, wait); else run();
  }
  const start = () => {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    setInterval(schedule, 1000);
    refreshSummary();
    schedule();
  };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
}
