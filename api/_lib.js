import { Redis } from "@upstash/redis";
import { timingSafeEqual } from "node:crypto";

// Upstash free tier counts commands, so every endpoint batches into one pipeline.
export const redis = Redis.fromEnv();

const same = (a, b) => a.length > 0 && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Who is calling: a person's name, "*" for the shared master key, or null if the key is wrong.
 *  HUB_VIEWERS is a JSON object of {key: person}; each of us holds our own. */
export function viewer(req) {
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!got) return null;
  if (same(got, process.env.HUB_KEY || "")) return "*";
  let map = {};
  try { map = JSON.parse(process.env.HUB_VIEWERS || "{}"); } catch { /* unset or malformed */ }
  for (const [key, person] of Object.entries(map)) if (same(got, key)) return person;
  return null;
}

export const authorized = (req) => viewer(req) !== null;

/** Project and chat names belong to whoever's laptop they came from. Everyone else sees the
 *  shape of the usage — how many projects, how it splits — under stable placeholder names. */
export function redact(snap, who) {
  if (!snap || who === "*" || (snap.person || snap.label) === who) return snap;
  const s = structuredClone(snap);
  const names = new Set();
  for (const w of ["window", "week"]) Object.keys(s[w]?.by_project || {}).forEach((n) => names.add(n));
  for (const ses of s.sessions || []) if (ses.project) names.add(ses.project);
  // Sorted so a project keeps the same placeholder from one sync to the next.
  const alias = new Map([...names].sort().map((n, i) => [n, `Project ${i + 1}`]));
  for (const w of ["window", "week"]) {
    const by = s[w]?.by_project;
    if (by) s[w].by_project = Object.fromEntries(Object.entries(by).map(([n, v]) => [alias.get(n) || "Project", v]));
  }
  for (const ses of s.sessions || []) {
    if (ses.project) ses.project = alias.get(ses.project) || "Project";
    if (ses.title) ses.title = null;      // chat titles say more than project names do
  }
  return s;
}

/** Same rule for the all-time history: its compaction log carries chat titles. */
export function redactDetail(detail, owner, who) {
  if (!detail || who === "*" || owner === who) return detail;
  const d = structuredClone(detail);
  for (const e of d.context?.after_compact || []) e.title = null;
  return d;
}

export const slug = (label) =>
  String(label || "").toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export const quantile = (arr, q) => {
  const a = [...arr].sort((m, n) => m - n);
  const i = (a.length - 1) * q, lo = Math.floor(i);
  return a[lo] + (a[Math.ceil(i)] - a[lo]) * (i - lo);
};

// Model families whose relative "weight" against the limit is learned separately.
export const FAMILIES = ["fable", "opus", "sonnet", "haiku", "other"];
export const family = (m) =>
  /fable|mythos/.test(m) ? "fable" : /opus/.test(m) ? "opus" : /sonnet/.test(m) ? "sonnet" : /haiku/.test(m) ? "haiku" : "other";
