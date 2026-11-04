import test from "node:test";
import assert from "node:assert/strict";
import { signSession } from "../../functions/_gate.js";
import { hasSession } from "../src/gate.js";
import { reserve, settle, stats } from "../src/budget-core.js";
import { estimateUsd, capUsd, actualUsd } from "../src/cost.js";
import { handle } from "../src/handler.js";
import * as C from "../src/constants.js";

const mapStore = () => { const m = new Map(); return { m, get: async (k) => m.get(k), put: async (k, v) => m.set(k, structuredClone(v)), delete: async (k) => Array.isArray(k) ? k.forEach((x) => m.delete(x)) : m.delete(k) }; };
const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);
const KEY = "k".repeat(32), PKEY = "p".repeat(32);
const req = (path, { cookie, method = "GET", body, ip = "203.0.113.5" } = {}) =>
  new Request("https://pla.example" + path, { method, body: body && JSON.stringify(body), headers: { "CF-Connecting-IP": ip, ...(cookie ? { Cookie: "pla_session=" + cookie } : {}) } });

test("cookie verification (prod + preview keys, expiry, tamper)", async () => {
  const env = { COOKIE_KEY: KEY, COOKIE_KEY_PREVIEW: PKEY };
  const good = await signSession(KEY, T0 + 3600e3), prev = await signSession(PKEY, T0 + 3600e3);
  assert.ok(await hasSession(req("/", { cookie: good }), env, T0));
  assert.ok(await hasSession(req("/", { cookie: prev }), env, T0));
  assert.ok(!(await hasSession(req("/", { cookie: good }), env, T0 + 7200e3)));
  assert.ok(!(await hasSession(req("/", { cookie: good.slice(0, -2) + "xx" }), env, T0)));
  assert.ok(!(await hasSession(req("/", { cookie: await signSession("other", T0 + 3600e3) }), env, T0)));
  assert.ok(!(await hasSession(req("/"), env, T0)));
  assert.ok(!(await hasSession(req("/", { cookie: good }), {}, T0)));
});

test("budget never exceeds cap and resets at UTC midnight", async () => {
  const s = mapStore(); const cap = 1; const est = 0.3; let ok = 0;
  for (let i = 0; i < 50; i++) { const r = await reserve(s, { ip: "ip" + i, estUsd: est, capUsd: cap, nowMs: T0, id: "a" + i }); if (r.ok) ok++; else assert.equal(r.reason, "budget"); }
  assert.equal(ok, 3);
  let g = await stats(s, T0); assert.ok(g.spent + g.reserved <= cap);
  // settle with actual usage frees headroom; null keeps full estimate
  await settle(s, { id: "a0", actualUsd: 0.01 }); await settle(s, { id: "a1", actualUsd: null });
  assert.equal((await settle(s, { id: "a1", actualUsd: 0 })).ok, false); // idempotent
  g = await stats(s, T0); assert.ok(Math.abs(g.spent - 0.31) < 1e-9 && Math.abs(g.reserved - 0.3) < 1e-9);
  assert.ok((await reserve(s, { ip: "x", estUsd: est, capUsd: cap, nowMs: T0, id: "b" })).ok);
  assert.ok(!(await reserve(s, { ip: "y", estUsd: est, capUsd: cap, nowMs: T0, id: "c" })).ok);
  const late = Date.UTC(2026, 10, 4, 23, 59, 59), next = Date.UTC(2026, 10, 5, 0, 0, 0);
  assert.ok(!(await reserve(s, { ip: "z", estUsd: est, capUsd: cap, nowMs: late, id: "d" })).ok);
  assert.ok((await reserve(s, { ip: "z", estUsd: est, capUsd: cap, nowMs: next, id: "e" })).ok);
});

test("cost estimate is conservative and cap clamps to $20", () => {
  const e = estimateUsd({ text: "x".repeat(3000) });
  const worst = actualUsd({ prompt_tokens: 1000 + C.PROMPT_OVERHEAD_TOKENS, completion_tokens: C.MAX_OUTPUT_TOKENS }) * C.MAX_ATTEMPTS;
  assert.ok(e >= worst);
  assert.equal(capUsd({}), 20); assert.equal(capUsd({ DAILY_BUDGET_USD: "500" }), 20); assert.equal(capUsd({ DAILY_BUDGET_USD: "0.5" }), 0.5);
});

test("per-IP rate limits (minute + day)", async () => {
  const s = mapStore(); const a = { estUsd: 0.0001, capUsd: 20 };
  for (let i = 0; i < C.PER_IP_PER_MINUTE; i++) assert.ok((await reserve(s, { ...a, ip: "1.1.1.1", nowMs: T0, id: "m" + i })).ok);
  const r = await reserve(s, { ...a, ip: "1.1.1.1", nowMs: T0, id: "mx" });
  assert.equal(r.status, 429); assert.equal(r.reason, "rate");
  assert.ok((await reserve(s, { ...a, ip: "2.2.2.2", nowMs: T0, id: "o" })).ok);
  assert.ok((await reserve(s, { ...a, ip: "1.1.1.1", nowMs: T0 + 60e3, id: "n" })).ok);
  let n = 0; for (let i = 0; i < 300; i++) { const x = await reserve(s, { ...a, ip: "3.3.3.3", nowMs: T0 + i * 60e3, id: "d" + i }); if (x.ok) n++; else assert.equal(x.reason, "ip-day"); }
  assert.equal(n, C.PER_IP_PER_DAY);
});

// fake env for handler
function fakeEnv(extra = {}) {
  const s = mapStore(); const rows = new Map(); const created = [];
  const stub = { reserve: (a) => reserve(s, a), settle: (a) => settle(s, a) };
  const RUNS_DB = { prepare(sql) { return { bind(...v) { return {
    async first() { const r = rows.get(v[0]); return r ? { ...r } : null; },
    async run() { if (sql.startsWith("INSERT")) rows.set(v[0], { id: v[0], tool: v[1], status: v[3] }); else { const r = rows.get(v.at(-1)); if (r) r.status = sql.includes("errored") ? "errored" : v[0]; } } }; } }; } };
  return { COOKIE_KEY: KEY, RUNS_DB, created, BUDGET: { idFromName: () => "g", get: () => stub },
    RUN_WORKFLOW: { create: async (o) => created.push(o), get: async () => ({ status: async () => ({ status: "running" }) }) }, ...extra };
}

test("handler: 401 without cookie, run created with cookie, resting when budget exhausted", async () => {
  const env = fakeEnv(); const ck = await signSession(KEY, T0 + 3600e3);
  for (const [p, m] of [["/api/run", "POST"], ["/api/run/r-12345678", "GET"]]) {
    const r = await handle(req(p, { method: m, body: m === "POST" ? { tool: "explain_quote", input: {} } : undefined }), env, T0);
    assert.equal(r.status, 401);
  }
  let r = await handle(req("/api/run", { method: "POST", cookie: ck, body: { tool: "nope", input: {} } }), env, T0);
  assert.equal(r.status, 400);
  r = await handle(req("/api/run", { method: "POST", cookie: ck, body: { tool: "explain_quote", input: { a: 1 } } }), env, T0);
  assert.equal(r.status, 202); const { runId } = await r.json(); assert.equal(env.created[0].id, runId);
  r = await handle(req("/api/run/" + runId, { cookie: ck }), env, T0);
  assert.equal((await r.json()).status, "queued");
  const tiny = fakeEnv({ DAILY_BUDGET_USD: "0.000001" });
  r = await handle(req("/api/run", { method: "POST", cookie: ck, body: { tool: "explain_quote", input: {} } }), tiny, T0);
  assert.equal(r.status, 503); assert.equal((await r.json()).message, "The demo is resting for today. Please try again tomorrow.");
  assert.equal(tiny.created.length, 0);
});
