import test from "node:test";
import assert from "node:assert/strict";
import * as parse from "../src/tools/parse_rfq_document.js";
import * as match from "../src/tools/match_library_part.js";
import * as explain from "../src/tools/explain_quote.js";

const fake = (out) => ({ calls: [], async json(a) { this.calls.push(a); return typeof out === "function" ? out(a) : structuredClone(out); } });
const EMAIL = `Please quote RFQ-1003 rev A for the BRK-300 welded mounting bracket per drawing BRK-300 rev A.
Material: ASTM A36 steel plate. Quantities: 250 and 2,500 pieces.
Delivery by 1 April 2027. Payment Net 30. We'd normally want it delivered to our dock (DAP?) but logistics will confirm.
Thanks,
Northwind Agricultural Equipment`;
const GOOD = { rfq_id: "RFQ-1003", revision: "A", customer: "Northwind Agricultural Equipment", payment_terms: "Net 30",
  incoterm: "DAP", delivery_date: "2027-04-01", drawing: "BRK-300 rev A", material_spec: "ASTM A36 steel plate", finish_spec: "",
  lines: [{ part: "BRK-300", description: "welded mounting bracket", quantities: [250, 2500] }],
  confidence: { customer: 0.95, incoterm: 0.5, delivery_date: 0.9, material_spec: 0.9, lines: 0.95 }, ambiguities: ["DAP tentative"] };

test("parse: good output", async () => {
  const ai = fake(GOOD);
  const r = await parse.run({ env: {}, input: { text: EMAIL }, ai });
  assert.deepEqual(r.lines[0].quantities, [250, 2500]);
  assert.equal(r.finish_spec, null);
  assert.ok(r.missing_fields.includes("finish_spec"));
  assert.ok(r.low_confidence.includes("incoterm"));
  assert.ok(r.found.includes("customer"));
  assert.ok(r.inferred.includes("delivery_date"));
  assert.match(ai.calls[0].user, /2,500/);
});
test("parse: missing quantity throws", async () => {
  const bad = structuredClone(GOOD); bad.lines[0].quantities = [];
  await assert.rejects(parse.run({ env: {}, input: EMAIL, ai: fake(bad) }), /quantity missing/);
});
test("parse: hallucinated quantity throws", async () => {
  const bad = structuredClone(GOOD); bad.lines[0].quantities = [250, 5000];
  await assert.rejects(parse.run({ env: {}, input: EMAIL, ai: fake(bad) }), /5000 not found/);
});
test("parse: non-integer quantity / bad date / empty input", async () => {
  const b1 = structuredClone(GOOD); b1.lines[0].quantities = [-1];
  await assert.rejects(parse.run({ env: {}, input: EMAIL, ai: fake(b1) }), /positive integer/);
  const b2 = structuredClone(GOOD); b2.delivery_date = "April 1";
  await assert.rejects(parse.run({ env: {}, input: EMAIL, ai: fake(b2) }), /YYYY-MM-DD/);
  await assert.rejects(parse.run({ env: {}, input: "", ai: fake(GOOD) }), /empty/);
});

test("match: good, low score, NONE, hallucinated", async () => {
  const r = await match.run({ env: {}, input: { line: "BRK-300 welded bracket" }, ai: fake({ product_id: "BRK-100", score: 0.91, method: "family+process", rationale: "same family" }) });
  assert.equal(r.matchedProduct, "ex:BRK-100"); assert.equal(r.written, true); assert.equal(r.confidence, "high");
  const lo = await match.run({ env: {}, input: { line: "x" }, ai: fake({ product_id: "BRK-100", score: 0.4, method: "m", rationale: "" }) });
  assert.equal(lo.written, false);
  const none = await match.run({ env: {}, input: { line: "x" }, ai: fake({ product_id: "NONE", score: 0, method: "m", rationale: "" }) });
  assert.equal(none.product, null);
  await assert.rejects(match.run({ env: {}, input: { line: "x" }, ai: fake({ product_id: "BRK-999", score: 0.9, method: "m", rationale: "" }) }), /unknown product/);
  await assert.rejects(match.run({ env: {}, input: { line: "x" }, ai: fake({ product_id: "BRK-100", score: 1.5, method: "m", rationale: "" }) }), /0\.\.1/);
  await assert.rejects(match.run({ env: {}, input: { line: "x", candidates: { "ENC-1": "Enclosure" } }, ai: fake({ product_id: "BRK-100", score: 0.9, method: "m", rationale: "" }) }), /unknown product/);
});

const Q = { quote: "Q-1003", breaks: [{ line: "L1", quantity: 250, unit_price: 41.37, nre: 0, freight: 0.8, total: 10342.5 },
  { line: "L1", quantity: 2500, unit_price: 33.12, nre: 0, freight: 0.8, total: 82800 }] };
test("explain: allowed numbers pass, invented numbers throw", async () => {
  const ok = { summary: "Quote Q-1003: 250 units at $41.37 each (total $10,342.50); 2,500 units at $33.12 each.", drivers: ["Setup spread over volume"], breaks: ["2,500 units: $82,800 total"], caveats: [] };
  const r = await explain.run({ env: {}, input: Q, ai: fake(ok) });
  assert.equal(r.quote, "Q-1003");
  const bad = { ...ok, breaks: ["1,000 units at $37.00"] };
  await assert.rejects(explain.run({ env: {}, input: Q, ai: fake(bad) }), /not in the computed quote/);
  await assert.rejects(explain.run({ env: {}, input: {}, ai: fake(ok) }), /breaks/);
});
