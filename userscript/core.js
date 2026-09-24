// Passive observer for claude.ai. Shared by the userscript and its Firefox test harness.
//
// It wraps the page's own fetch and reads copies of three responses the page was already
// fetching (main.js adds one re-read of the open chat when the hook was too late for it):
//   * the completion stream   -> model, reply size, and the plan limits after that message
//   * the conversation tree   -> the size of the chat that is open
//   * the /usage endpoint     -> the same limits, when the page shows its own usage
//
// Firefox is the awkward case. claude.ai's CSP forbids inline scripts, so a userscript manager
// cannot run code in the page there and falls back to a content script, which sees the page only
// through Xray wrappers. Reaching the page's fetch then takes window.wrappedJSObject, and any
// function the page will call — our fetch, and the callbacks we hang on the page's promises —
// has to go through exportFunction. Chromium managers inject into the page directly, where none
// of that applies. `install` handles both; the caller says which world it is in.

/* exported cuhInstall, cuhParseStream, cuhParseTree, cuhParseUsage, cuhTokens */

// Endpoints, matched on the path so the harness can serve them from localhost.
const CUH_COMPLETION = /\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?#]+)\/(retry_)?completion(?:[?#]|$)/;
const CUH_TREE = /\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?#]+)\?(?:[^#]*&)?tree=/i;
const CUH_USAGE = /\/api\/organizations\/([^/]+)\/usage(?:[?#]|$)/;

// Claude's tokenizer isn't published; ~3.7 characters per token matches it on English prose
// and code to within about 10%. Everything derived from it is labelled as an estimate.
const CUH_CHARS_PER_TOKEN = 3.7;
const cuhTokens = (chars) => Math.round((chars || 0) / CUH_CHARS_PER_TOKEN);

/** Plan limits out of a stream's message_limit record. Utilization there is a 0-1 fraction
 *  rounded to two places — whole percents, same as the /usage endpoint, not finer. */
function cuhLimits(ml) {
  const w = (ml && ml.windows) || {};
  const one = (x) => x && typeof x.utilization === "number"
    ? { pct: x.status === "exceeded_limit" ? 100 : Math.round(x.utilization * 100),
        resets_at: x.resets_at ? new Date(x.resets_at * 1000).toISOString() : null }
    : null;
  return { five: one(w["5h"]), week: one(w["7d"]), status: ml && ml.overageStatus || null };
}

/** Everything useful in a finished completion stream. Records are `data: {json}` lines. */
function cuhParseStream(text) {
  const out = { model: null, message: null, reply_chars: 0, limits: null, stopped: true };
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!/"(message_start|content_block_delta|message_limit|message_stop)"/.test(raw)) continue;
    let j;
    try { j = JSON.parse(raw); } catch { continue; }
    if (j.type === "message_start") {
      out.model = j.message && j.message.model || out.model;
      out.message = j.message && j.message.uuid || out.message;
    } else if (j.type === "content_block_delta" && j.delta) {
      out.reply_chars += (j.delta.text || j.delta.partial_json || "").length;
    } else if (j.type === "message_limit") {
      out.limits = cuhLimits(j.message_limit);
    } else if (j.type === "message_stop") {
      out.stopped = false;
    }
  }
  return out;
}

/** Size of the branch that is on screen. tree=true returns every branch, so walk back from the
 *  current leaf; text, pasted files and attachments all count toward the context. */
function cuhParseTree(json) {
  const msgs = (json && json.chat_messages) || [];
  const byId = new Map(msgs.map((m) => [m.uuid, m]));
  let branch = [];
  for (let m = byId.get(json && json.current_leaf_message_uuid); m; m = byId.get(m.parent_message_uuid)) branch.push(m);
  if (!branch.length) branch = msgs;
  let chars = 0;
  for (const m of branch) {
    for (const c of m.content || []) chars += (c.text || "").length + (c.input ? JSON.stringify(c.input).length : 0);
    for (const a of m.attachments || []) chars += (a.extracted_content || "").length;
    if (m.text) chars += m.text.length;
  }
  return {
    model: json && json.model || null, messages: branch.length, chars,
    tokens: cuhTokens(chars), updated_at: json && json.updated_at || null,
    in_project: !!(json && (json.project_uuid || json.project)),
  };
}

/** The page's own /usage fetch: integer percents, same shape the hub's OAuth reading has. */
function cuhParseUsage(json) {
  const one = (x) => x && typeof x.utilization === "number" ? { pct: Math.round(x.utilization), resets_at: x.resets_at || null } : null;
  return { five: one(json && json.five_hour), week: one(json && json.seven_day) };
}

/**
 * Wrap the page's fetch. `page` is the page's window (wrappedJSObject in a Firefox content
 * script); `exporting` is true when functions must be exported for the page to call them.
 * `emit` receives plain objects built on our side of the boundary.
 */
function cuhInstall(page, exporting, emit) {
  const orig = page.fetch;
  if (!orig || page.__cuhHooked) return false;
  const give = (fn) => (exporting ? exportFunction(fn, page) : fn);
  // Attach to a page promise without the page ever calling one of our own functions directly.
  const after = (promise, fn) => { try { promise.then(give(fn), give(() => {})); } catch (e) { /* never break the page */ } };

  const urlOf = (input) => {
    try {
      if (typeof input === "string") return input;
      if (input && typeof input.url === "string") return input.url;
      return String((input && input.href) || input || "");
    } catch (e) { return ""; }
  };

  function hooked(input, init) {
    const p = orig.call(page, input, init);
    let url = "", m;
    try { url = urlOf(input); } catch (e) { return p; }
    const t = new Date().toISOString();
    if ((m = CUH_COMPLETION.exec(url))) {
      const [, org, conv, retry] = m;
      after(p, (resp) => {
        let copy;
        try { copy = resp.clone(); } catch (e) { return; }
        after(copy.text(), (text) => {
          // A send refused at the limit answers with JSON, not a stream — still worth a reading.
          const s = resp.ok ? cuhParseStream(text) : { limits: null, refused: resp.status };
          emit({ kind: "completion", t, org, conv, retry: !!retry, ...s });
        });
      });
    } else if ((m = CUH_TREE.exec(url))) {
      const [, org, conv] = m;
      after(p, (resp) => {
        if (!resp.ok) return;
        let copy;
        try { copy = resp.clone(); } catch (e) { return; }
        after(copy.text(), (text) => {
          try { emit({ kind: "conversation", t, org, conv, ...cuhParseTree(JSON.parse(text)) }); } catch (e) { /* not JSON */ }
        });
      });
    } else if ((m = CUH_USAGE.exec(url))) {
      after(p, (resp) => {
        if (!resp.ok) return;
        let copy;
        try { copy = resp.clone(); } catch (e) { return; }
        after(copy.text(), (text) => {
          try { emit({ kind: "usage", t, org: m[1], ...cuhParseUsage(JSON.parse(text)) }); } catch (e) { /* not JSON */ }
        });
      });
    }
    return p;
  }

  if (exporting) exportFunction(hooked, page, { defineAs: "fetch" });
  else page.fetch = hooked;
  try { page.__cuhHooked = true; } catch (e) { /* frozen window */ }
  return true;
}
