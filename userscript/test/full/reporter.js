setTimeout(() => {
  const out = { path: location.pathname };
  try {
    const line = document.getElementById("cuh-line");
    out.lineExists = !!line;
    out.lineConnected = !!(line && line.isConnected);
    out.hasShadow = !!(line && line.shadowRoot);
    const root = line && line.shadowRoot && line.shadowRoot.querySelector(".root");
    out.line = root ? root.textContent.replace(/\s+/g, " ").trim() : null;
    out.rootClass = root ? root.className : null;
    out.lineAfterComposer = !!(line && line.previousElementSibling && line.previousElementSibling.classList.contains("bg-surface-3"));
    out.shadowKids = line && [...line.shadowRoot.children].map((c) => c.tagName + "." + c.className);
    out.shadowTail = line && line.shadowRoot.innerHTML.slice(-300);
    const split = (id) => { const e = document.getElementById(id); return e ? { inModal: !!e.closest('[role="dialog"]'),
      after: (e.previousElementSibling ? e.previousElementSibling.textContent : "").replace(/\s+/g, " ").trim().slice(0, 40),
      text: e.shadowRoot.querySelector(".root").textContent.replace(/\s+/g, " ").trim() } : null; };
    out.splitFive = split("cuh-split-five"); out.splitWeek = split("cuh-split-week");
    const fc = document.getElementById("cuh-forecast");
    out.forecast = fc && fc.shadowRoot ? fc.shadowRoot.querySelector(".root").textContent.replace(/\s+/g, " ").trim().slice(0, 90) : null;
    const dg = document.getElementById("cuh-diag");
    out.diag = dg && dg.shadowRoot ? dg.shadowRoot.querySelector(".root").textContent.replace(/\s+/g, " ").trim() : null;
  } catch (e) { out.err = String(e) + " @ " + (e.stack || "").split("\n")[0]; }
  fetch("http://127.0.0.1:8765/report?who=ui", { method: "POST", body: JSON.stringify(out) });
}, 6500);
