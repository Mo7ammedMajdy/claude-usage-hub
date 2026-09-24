// Dump every device's calibration readings from Redis to tools/data/samples.json.
//   cd ~/Projects/claude-usage-hub && set -a && . ./.env.prod && set +a && node tools/dump.mjs
import { Redis } from "@upstash/redis";
import { writeFileSync } from "node:fs";
import { SK } from "../api/ingest.js";
const r = Redis.fromEnv();
const out = {};
for (const n of await r.hkeys("devices"))
  out[n] = (await r.lrange(`ds:${n}`, 0, -1)).map((v) => (typeof v === "string" ? JSON.parse(v) : v)).map((a) => Object.fromEntries(SK.map((k, i) => [k, a[i]])));
writeFileSync(new URL("./data/samples.json", import.meta.url), JSON.stringify(out));
console.log(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])));
