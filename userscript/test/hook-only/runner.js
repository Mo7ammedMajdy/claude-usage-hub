// Exactly what the userscript does when Violentmonkey falls back to a content script on Firefox.
const report = (who, o) => fetch("http://127.0.0.1:8765/report?who=" + who, { method: "POST", body: JSON.stringify(o) });
const page = window.wrappedJSObject;
let ok = false, err = null;
try { ok = cuhInstall(page, typeof exportFunction === "function", (ev) => report("hook", ev)); }
catch (e) { err = String(e); }
report("install", { ok, err, exportFunction: typeof exportFunction, wrapped: typeof window.wrappedJSObject });
