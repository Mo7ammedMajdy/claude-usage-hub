// Stretches the week forecast should treat as one-offs (the fit still uses them).
//   set -a && . ./.env.prod && set +a
//   node tools/forecast-ignore.mjs                                  list
//   node tools/forecast-ignore.mjs add 2026-09-18T01:00Z 2026-09-20T14:00Z "the Sep 18-20 spike"
//   node tools/forecast-ignore.mjs remove <index>
// Takes effect at the next refit (every 15 min, or on a laptop's reprice).
import { Redis } from "@upstash/redis";
const r = Redis.fromEnv();
const [cmd, a, b, note] = process.argv.slice(2);
let list = (await r.get("forecast:ignore")) || [];
if (typeof list === "string") list = JSON.parse(list);
if (cmd === "add") {
  if (!(Date.parse(a) < Date.parse(b))) { console.error("usage: add <from ISO> <to ISO> <note>"); process.exit(1); }
  list.push({ from: new Date(a).toISOString(), to: new Date(b).toISOString(), note: note || "a one-off" });
  await r.set("forecast:ignore", JSON.stringify(list));
} else if (cmd === "remove") {
  list.splice(Number(a), 1);
  await r.set("forecast:ignore", JSON.stringify(list));
}
list.forEach((g, i) => console.log(i, g.from, "→", g.to, g.note));
if (!list.length) console.log("(nothing ignored)");
