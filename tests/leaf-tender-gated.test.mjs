// /leaf-tender must sit behind the same gate; when bound, proxy to LEAF_TENDER worker.
import assert from "node:assert/strict";
import { onRequest } from "../functions/_middleware.js";

const env = { PLA_SECRET: "right-one", COOKIE_KEY: "k".repeat(32) };
const next = async () => new Response("PAGES CONTENT", { status: 200 });

for (const path of ["/leaf-tender", "/leaf-tender/", "/leaf-tender/api/health"]) {
  const r = await onRequest({ env, next, request: new Request("https://x.pages.dev" + path, { headers: { "CF-Connecting-IP": "203.0.113.7" } }) });
  assert.equal(r.status, 401, path);
  const body = await r.text();
  assert.ok(body.includes("Secret?") && !body.includes("PAGES CONTENT"), path);
}

// With a valid session and no binding → 503
import { signSession } from "../functions/_gate.js";
const token = await signSession(env.COOKIE_KEY, Date.now() + 3600_000);
const r503 = await onRequest({
  env, next,
  request: new Request("https://x.pages.dev/leaf-tender/", { headers: { Cookie: `pla_session=${token}`, "CF-Connecting-IP": "203.0.113.7" } }),
});
assert.equal(r503.status, 503);

// With binding → proxied, prefix stripped
let seen;
env.LEAF_TENDER = { fetch: async (req) => { seen = new URL(req.url); return new Response("LT OK", { status: 200 }); } };
const rOk = await onRequest({
  env, next,
  request: new Request("https://x.pages.dev/leaf-tender/api/health", { headers: { Cookie: `pla_session=${token}`, "CF-Connecting-IP": "203.0.113.7" } }),
});
assert.equal(rOk.status, 200);
assert.equal(await rOk.text(), "LT OK");
assert.equal(seen.pathname, "/api/health");
console.log("leaf-tender gated ok");
