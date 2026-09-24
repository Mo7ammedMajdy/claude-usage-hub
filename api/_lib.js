import { Redis } from "@upstash/redis";
import { createHash, timingSafeEqual } from "node:crypto";

// Upstash free tier counts commands, so every endpoint batches into one pipeline.
export const redis = Redis.fromEnv();

// Compared as SHA-256 digests: always 32 bytes each, so timingSafeEqual can't throw on a length
// mismatch (a non-ASCII key used to, as a 500) and the key's length doesn't leak through timing.
const digest = (s) => createHash("sha256").update(String(s)).digest();
export const same = (a, b) => {
  try { return a.length > 0 && b.length > 0 && timingSafeEqual(digest(a), digest(b)); } catch { return false; }
};

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

// Claude Code's own agent types say nothing about the work; a custom agent's name can.
const BUILTIN_AGENTS = new Set(["general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide",
  "output-style-setup", "workflow-subagent"]);
// What someone else's session may show: numbers, times, models. Anything else a laptop sends
// (titles, agent descriptions, fields added later) stays with its owner unless listed here.
const SESSION_KEYS = ["id", "platform", "start", "last", "calls", "x", "r", "tokens", "current_model", "models", "changes",
  "switches", "ctx_max", "ctx_last", "ctx_avg", "recent", "compactions"];
const AGENT_KEYS = ["id", "parent", "depth", "calls", "x", "r", "tokens", "models", "first", "last"];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/** Project and chat names belong to whoever's laptop they came from. Everyone else sees the
 *  shape of the usage — how many projects, how it splits — under stable placeholder names. */
export function redact(snap, who) {
  if (!snap || who === "*" || (snap.person || snap.label) === who) return snap;
  const s = structuredClone(snap);
  const sessions = (s.sessions || []).filter((x) => x && typeof x === "object");
  const names = new Set();
  for (const w of ["window", "week"]) Object.keys(s[w]?.by_project || {}).forEach((n) => names.add(n));
  for (const ses of sessions) if (ses.project) names.add(ses.project);
  // Sorted so a project keeps the same placeholder from one sync to the next.
  const alias = new Map([...names].sort().map((n, i) => [n, `Project ${i + 1}`]));
  for (const w of ["window", "week"]) {
    const by = s[w]?.by_project;
    if (by) s[w].by_project = Object.fromEntries(Object.entries(by).map(([n, v]) => [alias.get(n) || "Project", v]));
  }
  s.sessions = sessions.map((ses) => ({
    ...pick(ses, SESSION_KEYS),
    project: ses.project ? alias.get(ses.project) || "Project" : null,
    title: null,                        // chat titles say more than project names do
    agents: (Array.isArray(ses.agents) ? ses.agents : []).filter((a) => a && typeof a === "object").map((a) => ({
      ...pick(a, AGENT_KEYS), type: BUILTIN_AGENTS.has(a.type) ? a.type : "agent", desc: null })),
  }));
  delete s.host;                        // the laptop's hostname: never shown, and often a name
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

// ---- Input validation. Whatever a laptop or browser sends is stored and later drawn on the
// dashboard, so it is cut down to the expected shapes first: numbers stay finite and in range,
// ids keep only id characters, dates must be ISO, free text loses control characters and angle
// brackets (as ‹›, so it still reads) and is capped. Each helper returns a cleaner; a value
// that doesn't fit becomes null.
export const plain = (v) => v != null && typeof v === "object" && !Array.isArray(v);
export const num = (lo = -Infinity, hi = Infinity) => (v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};
/** A limit's %. At the limit a reading can overshoot a little; that still means 100. */
export const pct = (v) => { const n = num(0, 110)(v); return n == null ? null : Math.min(100, n); };
export const id = (max = 60) => (v) =>
  ((typeof v === "string" || typeof v === "number") && String(v).replace(/[^\w.:-]/g, "").slice(0, max)) || null;
export const text = (max = 200) => (v) =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").replace(/</g, "‹").replace(/>/g, "›").slice(0, max) : null;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,9})?)?(Z|[+-]\d\d:?\d\d)?$/;
// Kept as sent, not re-serialised: window ids are compared as strings across laptops.
export const when = (v) => (typeof v === "string" && v.length <= 40 && ISO.test(v) && Number.isFinite(Date.parse(v)) ? v : null);
export const day = (v) => (typeof v === "string" && /^\d{4}-\d\d-\d\d$/.test(v) ? v : null);
export const bool = (v) => (typeof v === "boolean" ? v : null);
/** Arrays: at most `max` items; items that don't fit vanish, unless `keep` (positional, e.g. hours). */
export const list = (f, max, keep = false) => (v) => (Array.isArray(v) ? v.slice(0, max).map(f).filter((x) => keep || x != null) : []);
/** Objects with known keys: only the listed ones survive, and only if they were sent. */
export const obj = (shape) => (v) => (plain(v)
  ? Object.fromEntries(Object.keys(shape).filter((k) => v[k] !== undefined).map((k) => [k, shape[k](v[k])])) : null);
/** Objects keyed by name (by_model, hourly…): cleaned keys, at most `max` of them. */
export const map = (key, f, max) => (v) => (plain(v)
  ? Object.fromEntries(Object.entries(v).slice(0, max).map(([k, x]) => [key(k), f(x)]).filter(([k]) => k != null)) : null);
