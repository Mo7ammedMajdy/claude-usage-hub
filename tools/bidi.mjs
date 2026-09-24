// Minimal WebDriver BiDi client for a Firefox started with --remote-debugging-port.
//   node bidi.mjs <port> nav <url> [waitMs]
//   node bidi.mjs <port> eval "<js expression returning JSON-able value>"
//   node bidi.mjs <port> shot <out.png>
import { writeFileSync } from "node:fs";

const [port, cmd, arg, extra] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, (d) => (d.type === "error" ? rej(new Error(`${method}: ${d.error} ${d.message}`)) : res(d.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});

ws.onopen = async () => {
  try {
    await send("session.new", { capabilities: {} });
    const tree = await send("browsingContext.getTree", {});
    // CTX=<substring> picks the tab whose URL contains it; `tabs` lists them.
    const want = process.env.CTX;
    const context = (want ? tree.contexts.find((c) => c.url.includes(want)) : null)?.context || tree.contexts[0].context;
    if (cmd === "tabs") { console.log(tree.contexts.map((c) => c.url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>")).join("\n")); }
    if (cmd === "nav") {
      await send("browsingContext.navigate", { context, url: arg, wait: "complete" });
      await new Promise((r) => setTimeout(r, Number(extra || 4000)));
      console.log("ok", arg);
    } else if (cmd === "eval") {
      const r = await send("script.evaluate", {
        expression: `(async () => JSON.stringify(await (async () => (${arg}))()))()`,
        target: { context }, awaitPromise: true, resultOwnership: "none",
      });
      if (r.type === "exception") console.log("EXCEPTION", JSON.stringify(r.exceptionDetails).slice(0, 600));
      else console.log(r.result.value);
    } else if (cmd === "shot") {
      const r = await send("browsingContext.captureScreenshot", { context });
      writeFileSync(arg, Buffer.from(r.data, "base64"));
      console.log("saved", arg);
    }
  } catch (e) {
    console.log("ERROR", e.message);
  } finally {
    try { await send("session.end", {}); } catch (e) { /* already gone */ }
    ws.close();
  }
};
ws.onerror = (e) => { console.log("WS ERROR", e.message || e); process.exit(1); };
