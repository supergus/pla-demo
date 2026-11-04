// Exercises the full middleware with a fake D1 and fake next().
import assert from "node:assert/strict";
import { onRequest } from "../functions/_middleware.js";
const rows = [];
let dbBroken = false;
const DB = { prepare(sql) { return { bind(...a) { return {
  async run() { if (dbBroken) throw new Error("d1 down"); rows.push({ ts: a[0], ip: a[1], ok: a[3] }); },
  async first() { if (dbBroken) throw new Error("d1 down");
    const since = a[1]; const m = sql.includes("LIKE") ? (r) => r.ip.startsWith(a[0].slice(0, -1)) : (r) => r.ip === a[0];
    return { n: rows.filter((r) => m(r) && r.ok === 0 && r.ts > since).length }; } }; } }; } };
const env = { DB, PLA_SECRET: "right-one", COOKIE_KEY: "k".repeat(32) };
const next = async () => new Response("SECRET CONTENT", { status: 200 });
const req = (path, opt = {}, ip = "203.0.113.9") => new Request("https://x.pages.dev" + path, { ...opt, headers: { "CF-Connecting-IP": ip, ...(opt.headers || {}) } });
const login = (secret, ip, nxt = "/app.js") => onRequest({ env, next, request: req("/__login", { method: "POST", body: new URLSearchParams({ secret, next: nxt }) }, ip) });

let r = await onRequest({ env, next, request: req("/") });
assert.equal(r.status, 401); const body = await r.text();
assert.ok(body.includes("Secret?") && !body.includes("SECRET CONTENT") && !body.includes("right-one"));
assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
r = await onRequest({ env, next, request: req("/", { headers: { Cookie: "pla_session=v1.9999999999.junk" } }) });
assert.equal(r.status, 401);
for (let i = 0; i < 5; i++) assert.equal((await login("nope", "2001:db8:1:2::" + i)).status, 401);
r = await login("right-one", "2001:db8:1:2::99");
assert.equal(r.status, 429); assert.equal(r.headers.get("retry-after"), "900");
assert.equal(rows.length, 6);
r = await login("right-one", "198.51.100.7", "//evil.com");
assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "/");
const ck = r.headers.get("set-cookie");
assert.match(ck, /^pla_session=v1\.\d+\.[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=259200$/);
r = await onRequest({ env, next, request: req("/app.js", { headers: { Cookie: ck.split(";")[0] } }) });
assert.equal(r.status, 200); assert.equal(await r.text(), "SECRET CONTENT"); assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
dbBroken = true;
assert.equal((await login("nope", "198.51.100.8")).status, 401);
assert.equal((await onRequest({ env: { ...env, PLA_SECRET: undefined }, next, request: req("/__login", { method: "POST", body: new URLSearchParams({ secret: "" }) }) })).status, 401);
assert.equal((await onRequest({ env: { ...env, COOKIE_KEY: undefined }, next, request: req("/", { headers: { Cookie: ck.split(";")[0] } }) })).status, 401);
console.log("middleware tests ok");
