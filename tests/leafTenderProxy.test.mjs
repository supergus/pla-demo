import test from "node:test";
import assert from "node:assert/strict";
import { prefixLocation } from "../functions/_middleware.js";
const r = (loc) => new Response(null, { status: 307, headers: loc ? { Location: loc } : {} });
test("root-absolute redirect from Leaf Tender stays under /leaf-tender", () => {
  assert.equal(prefixLocation(r("/login"), "/leaf-tender").headers.get("Location"), "/leaf-tender/login");
});
test("already-prefixed, relative, protocol-relative and absent Locations untouched", () => {
  for (const l of ["/leaf-tender/x", "./login.html", "//evil.example/", "https://a.b/c"]) assert.equal(prefixLocation(r(l), "/leaf-tender").headers.get("Location"), l);
  assert.equal(prefixLocation(r(), "/leaf-tender").headers.get("Location"), null);
});
