import assert from "node:assert/strict";
import { safeEqual, signSession, verifySession, safeNext, rateKey } from "../functions/_gate.js";
const K = "k".repeat(32);
assert.equal(await safeEqual("abc", "abc"), true);
assert.equal(await safeEqual("abc", "abd"), false);
assert.equal(await safeEqual("", "x"), false);
const t = await signSession(K, Date.now() + 60000);
assert.equal(await verifySession(K, t), true);
assert.equal(await verifySession("other", t), false);
assert.equal(await verifySession(K, t.slice(0, -2) + "xx"), false);
assert.equal(await verifySession(K, t.replace(/v1\.\d+/, "v1.9999999999")), false);
assert.equal(await verifySession(K, await signSession(K, Date.now() - 1000)), false);
assert.equal(await verifySession(K, "garbage"), false);
assert.equal(await verifySession(K, null), false);
assert.equal(await verifySession("", t), false);
assert.equal(safeNext("/a?b=1"), "/a?b=1");
for (const bad of ["//evil.com", "https://evil.com", "/\\evil", "evil", "/__login", "/x\r\nSet-Cookie: a"]) assert.equal(safeNext(bad), "/");

console.log("gate tests ok");
