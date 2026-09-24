// Stand-ins for Violentmonkey's GM_* in a Firefox content script; hub calls go to the mock.
const MOCK = "http://127.0.0.1:8765";
const store = { hubKey: "test-key" };
function GM_getValue(k, d) { return k in store ? store[k] : d; }
function GM_setValue(k, v) { store[k] = v; }
function GM_xmlhttpRequest(o) {
  // ?hub401 on the page: answer like a hub that doesn't know the key, to show the warning pill.
  if (location.search.includes("hub401")) { setTimeout(() => o.onload({ status: 401, responseText: "{}" }), 50); return; }
  fetch(o.url.replace("https://claude-usage-hub.vercel.app", MOCK + "/hub"), { method: o.method, headers: o.headers, body: o.data })
    .then(async (r) => o.onload({ status: r.status, responseText: await r.text() })).catch(() => o.onerror && o.onerror());
}
function GM_registerMenuCommand() {}
const GM_info = { script: { version: "test" } };
