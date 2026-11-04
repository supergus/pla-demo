// /actual/ (PCAQ ontology viewer) must sit behind the same gate as the rest of the site.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { onRequest } from "../functions/_middleware.js";
const env = { PLA_SECRET: "right-one", COOKIE_KEY: "k".repeat(32) };
const next = async () => new Response("SECRET CONTENT", { status: 200 });
for (const path of ["/actual/", "/actual/index.html", "/actual/data/pcaq.ttl", "/actual/vendor/oxigraph/web_bg.wasm"]) {
  const r = await onRequest({ env, next, request: new Request("https://x.pages.dev" + path, { headers: { "CF-Connecting-IP": "203.0.113.7" } }) });
  assert.equal(r.status, 401, path); const body = await r.text();
  assert.ok(body.includes("Secret?") && !body.includes("SECRET CONTENT"), path);
}
assert.ok(existsSync("public/actual/index.html") && existsSync("public/actual/data/pcaq.ttl"), "public/actual not synced");
console.log("actual gated ok");
