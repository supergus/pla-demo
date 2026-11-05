// /leaf-tender redirects to leaftender.chriscouch.net (suite owns its own login — no Secret? required).
import assert from "node:assert/strict";
import { onRequest, leafTenderRedirect } from "../functions/_middleware.js";

const env = { PLA_SECRET: "right-one", COOKIE_KEY: "k".repeat(32) };
const next = async () => new Response("PAGES CONTENT", { status: 200 });

for (const [path, expectLoc] of [
  ["/leaf-tender", "https://leaftender.chriscouch.net/"],
  ["/leaf-tender/", "https://leaftender.chriscouch.net/"],
  ["/leaf-tender/api/health", "https://leaftender.chriscouch.net/api/health"],
  ["/leaf-tender/ts.html?trace=tr_x", "https://leaftender.chriscouch.net/ts.html?trace=tr_x"],
]) {
  const r = await onRequest({ env, next, request: new Request("https://x.pages.dev" + path, { headers: { "CF-Connecting-IP": "203.0.113.7" } }) });
  assert.equal(r.status, 302, path);
  assert.equal(r.headers.get("location"), expectLoc, path);
}

const r = leafTenderRedirect(new URL("https://pla.chriscouch.net/leaf-tender/ts.html?trace=tr_ICBLANK1"));
assert.equal(r.status, 302);
assert.equal(r.headers.get("location"), "https://leaftender.chriscouch.net/ts.html?trace=tr_ICBLANK1");

// LEAF_TENDER service binding must not be consulted
let called = false;
const redirected = await onRequest({
  env: { ...env, LEAF_TENDER: { fetch: async () => { called = true; return new Response("nope"); } } },
  next,
  request: new Request("https://x.pages.dev/leaf-tender/login.html", { headers: { "CF-Connecting-IP": "203.0.113.7" } }),
});
assert.equal(redirected.status, 302);
assert.equal(redirected.headers.get("location"), "https://leaftender.chriscouch.net/login.html");
assert.equal(called, false);

console.log("leaf-tender redirect ok");
