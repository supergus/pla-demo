import test from "node:test";
import assert from "node:assert/strict";
import { leafTenderRedirect } from "../functions/_middleware.js";

test("leaf-tender redirect strips prefix and keeps query", () => {
  const r = leafTenderRedirect(new URL("https://pla.chriscouch.net/leaf-tender/ts.html?trace=tr_x"));
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("Location"), "https://leaftender.chriscouch.net/ts.html?trace=tr_x");
});

test("leaf-tender bare path redirects to suite root", () => {
  const r = leafTenderRedirect(new URL("https://pla.chriscouch.net/leaf-tender"));
  assert.equal(r.headers.get("Location"), "https://leaftender.chriscouch.net/");
});

test("leaf-tender trailing slash redirects to suite root", () => {
  const r = leafTenderRedirect(new URL("https://pla.chriscouch.net/leaf-tender/"));
  assert.equal(r.headers.get("Location"), "https://leaftender.chriscouch.net/");
});
