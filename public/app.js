import { MODEL, costQuote } from "./cost.js";
import { runTool, MODEL_LABEL } from "./api.js";
import { kb, loadKB, resetStore, validateRFQ, fixTurtle, applyFix, sparql, completeRFQ, COMPLETE_RFQ_ASK, QUERIES } from "./kb.js";

const KEY = "rfqdemo.run.v2", HKEY = "rfqdemo.history.v1";
const STAGES = ["intake", "validate", "match", "cost", "approve", "send"];
const MAX_ATTEMPTS = 4, BASE_BACKOFF = 1000, PACE = 900;
const $ = (id) => document.getElementById(id);
const fmt = (x, d = 2) => x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

window.__pla = { get state() { return state; }, get net() { return net; }, kb, sparql };
let REASONER = null;
let SHACL = null, state = null, loopToken = 0, net = null, nodesDS = null, edgesDS = null;

// ---------- tools ----------
const TOOLS = {
  parse_rfq_document: { kind: "ai", canned: true, desc: "RFQ package (email + drawing PDF) to draft RFQ facts. Calls the rfq-pla Worker (Llama 3.3 70B) on the RFQ-1003 sample email; scripted RFQ-1002 facts drive the graph" },
  validate_rfq: { kind: "det", live: true, desc: "SHACL completeness check (shapes/rfq-completeness.ttl), run in your browser by shacl-engine" },
  classify_rfq: { kind: "det", live: true, desc: "Is RFQ-1002 a rfq:CompleteRFQ? Live SPARQL check of the OWL definition, plus the build-time HermiT result (replayed)" },
  match_library_part: { kind: "ai", canned: true, desc: "Match the RFQ line to a known product (rfq:SimilarityMatch, live via the rfq-pla Worker) and each BOM line to a library entry; record score + method" },
  explode_bom: { kind: "det", desc: "Expand the matched BOM and routings into cost drivers" },
  cost_quote: { kind: "det", desc: "Cost calculator (JS port of scripts/quote.py), one price per quantity break" },
  explain_quote: { kind: "ai", canned: true, desc: "Plain-language explanation of the computed quote (rfq-pla Worker; the model never does arithmetic)" },
  render_quote: { kind: "det", desc: "Render the approved quote document" },
};
function badges(tool, rec) {
  const t = TOOLS[tool]; let h = t.kind === "ai" ? '<span class="b ai">AI</span>' : '<span class="b det">deterministic</span>';
  if (rec && rec.live) h += `<span class="b live">live · ${MODEL_LABEL}</span><span class="b det">${rec.live.ms} ms${rec.live.usage ? ` · ${rec.live.usage.prompt_tokens ?? "?"}+${rec.live.usage.completion_tokens ?? "?"} tok` : ""}${rec.live.attempts ? ` · ${rec.live.attempts} attempts` : ""}</span>`;
  else if (rec && rec.fallback) h += `<span class="b canned" title="${esc(rec.fallback.message)}">scripted (fallback)</span><span class="b fb">${esc(rec.fallback.reason)}</span>`;
  else if (t.canned) h += '<span class="b canned">canned</span>';
  const replay = rec ? rec.replay : (t.live && !kb.ready);
  if (t.live && !replay) h += '<span class="b live">live</span>';
  if (replay) h += '<span class="b replay">replayed</span>';
  if (tool === "classify_rfq") h += '<span class="b replay">+ HermiT replayed</span>';
  return h;
}

// ---------- graph helpers ----------
function addNode(id, label, group, title) { if (!state.nodes.find((n) => n.id === id)) state.nodes.push({ id, label, group, title: title || label }); }
function setNode(id, patch) { const n = state.nodes.find((x) => x.id === id); if (n) Object.assign(n, patch); }
function addEdge(from, to, label, extra) { const id = `${from}|${label}|${to}`; if (!state.edges.find((e) => e.id === id)) state.edges.push({ id, from, to, label, ...(extra || {}) }); }

// ---------- PLA plan (each step = one tool call or one gate) ----------
const STEPS = [
  { stage: "intake", tool: "parse_rfq_document", input: () => ({ package: "RFQ-1002 package (sample)", files: ["RFQ-1002 email.eml", "DWG-BRK-200 rev A.pdf"] }),
    run: async (runId, rec) => {
      const live = await liveTool(rec, "parse_rfq_document", { text: RFQ_1003_EMAIL });
      addNode("RFQ-1002", "RFQ-1002 rev A\na rfq:RFQPackage", "rfq"); addNode("NORTHWIND", "Northwind Agricultural Equipment", "party"); addEdge("RFQ-1002", "NORTHWIND", "issuedBy");
      addNode("CT", "Commercial terms\nNet 30", "terms"); addEdge("RFQ-1002", "CT", "hasCommercialTerms");
      addNode("DT", "Delivery terms\n2027-03-01", "terms"); addEdge("RFQ-1002", "DT", "hasDeliveryTerms");
      addNode("DWG", "Drawing BRK-200 rev A", "doc"); addEdge("RFQ-1002", "DWG", "hasTechnicalRequirement");
      addNode("L1", "Line 1: BRK-200 bracket", "line"); addEdge("RFQ-1002", "L1", "hasLine");
      for (const q of MODEL.breaks) { addNode("QB" + q, "Qty " + q.toLocaleString(), "qty"); addEdge("L1", "QB" + q, "hasQuantityBreak"); }
      return { rfq: "ex:RFQ-1002", revision: "A", issuedBy: "ex:NORTHWIND", paymentTerms: "Net 30", requestedDeliveryDate: "2027-03-01T00:00:00", drawing: "ex:DWG-BRK-200",
        line: { product: "BRK-200 bracket", quantityBreaks: MODEL.breaks }, incoterm: null, materialSpec: null,
        lowConfidence: [], note: "Scripted RFQ-1002 facts drive the graph and SHACL check.",
        ...(live ? { liveParse: { source: "RFQ-1003 sample email", ...live } } : {}) };
    } },
  { stage: "validate", tool: "validate_rfq", input: () => ({ focus: "ex:RFQ-1002", shapes: "shapes/rfq-completeness.ttl" }),
    run: async (runId, rec) => {
      const r = await shaclRun(null, SHACL.before, rec);
      for (const v of r.results) raiseIssue({ id: "SH-" + v.shape, title: v.message, detail: `SHACL shape shp:${v.shape} failed on ex:${v.focus} (${rec.replay ? "replayed pySHACL result" : "live shacl-engine result"})`, owner: "human", kind: v.shape });
      return r;
    },
    after: (out) => out.conforms ? null : "awaitFixes" },
  { stage: "validate", tool: "validate_rfq", input: () => ({ focus: "ex:RFQ-1002", shapes: "shapes/rfq-completeness.ttl", addedFacts: (state.fixTurtle || "").split("\n").filter((l) => l.startsWith("ex:")) }),
    run: async (runId, rec) => shaclRun(state.fixTurtle, SHACL.after, rec) },
  { stage: "validate", tool: "classify_rfq", input: () => ({ individual: "ex:RFQ-1002", definedClass: "rfq:CompleteRFQ (owl:equivalentClass, ontology/rfq-package.ttl)" }),
    run: (runId, rec) => classify(rec) },
  { stage: "match", tool: "match_library_part", input: () => ({ product: "BRK-200 bracket", bomLines: MODEL.bom.map((b) => b.id) }),
    run: async (runId, rec) => {
      const live = await liveTool(rec, "match_library_part", { line: "RFQ-1002 line 1: BRK-200 welded mounting bracket", requirements: ["ASTM A36 steel plate"], candidates: { "BRK-100": "BRK-100 welded mounting bracket" } });
      const sm = plaMatch();
      if (live && live.matchedProduct) Object.assign(sm, { product: live.matchedProduct, score: String(live.score), method: live.method, confidence: live.confidence, run: runId, source: "rfq-pla Worker (live)" });
      addNode("BRK-100", "Product BRK-100\n(known, has BOM)", "product");
      addNode("SM-1002-L1", `rfq:SimilarityMatch (PLA)\nRFQ line → ${sm.product.replace("ex:", "")}\nscore ${sm.score} · ${sm.method}`, "plamatch",
        `SM-1002-L1: ${sm.line} → ${sm.product}, similarityScore ${sm.score}, similarityMethod "${sm.method}", confidence ${sm.confidence}, written by ${sm.run}`);
      addEdge("L1", "SM-1002-L1", "hasLineMatch"); addEdge("SM-1002-L1", "BRK-100", "matchedProduct"); addEdge("L1", "BRK-100", "forProduct");
      addNode("BOM", "EBOM BRK-100", "line"); addEdge("BRK-100", "BOM", "hasBOM");
      const out = [];
      for (const b of MODEL.bom) {
        addNode(b.id, `${b.id} ${b.component}`, "bom"); addEdge("BOM", b.id, "hasBOMLine");
        const m = "SM-" + b.id;
        addNode(m, b.override ? `Match: manual override\nconfidence low` : `Match → ${b.entry}\nscore ${b.score} · ${b.method}`, "match");
        addEdge(b.id, m, "hasSimilarityMatch");
        if (b.entry) { addNode("LIB-" + b.entry, `Library ${b.entry}\n$${b.unitCost.toFixed(2)}`, "lib"); addEdge(m, "LIB-" + b.entry, "matchedEntry"); }
        out.push({ bomLine: b.id, matchedEntry: b.entry, similarityScore: b.score, similarityMethod: b.method, confidence: b.confidence, manualOverride: !!b.override, ...(b.override ? { overrideUnitCost: b.unitCost } : {}) });
      }
      raiseIssue({ id: "LOWCONF-BL-5", title: "BL-5 priced by manual override", detail: "No library entry for the serial-number label. Override unit cost $0.25 recorded with confidence low (CQ7 manual review).", owner: "PLA", kind: "note", resolved: true, resolution: "Accepted: override recorded as a fact" });
      return { similarityMatch: sm, matches: out, note: live ? "RFQ-line match from the live model; BOM-line matches are scripted." : "Scripted fallback: the RFQ-line match values are read live (SPARQL, CQ12) from data/pla-run-1002.ttl in rfq-ontology." };
    } },
  { stage: "cost", tool: "explode_bom", input: () => ({ bom: "ex:BOM-BRK-100", quoteDate: MODEL.quoteDate }),
    run: () => {
      const r = costQuote(MODEL, "DAP");
      for (const [wc, v] of Object.entries(MODEL.workCenters)) { addNode(wc, `${wc}\n$${v.labor + v.machine + v.burden}/h`, "rate"); }
      for (const c of r.convLines) addEdge("LIB-" + MODEL.bom.find((b) => b.id === c.line).entry, c.wc, "routing step");
      return { unitMaterial: +r.material.toFixed(4), setupCostPerLot: +r.setupPerLot.toFixed(2), runCostPerUnit: +r.runPerUnit.toFixed(2), materialLines: r.matLines, routingSteps: r.convLines.map(({ line, op, wc, rate }) => ({ line, op, wc, rate })) };
    } },
  { stage: "cost", tool: "cost_quote", input: () => ({ line: "ex:RFQ-1002-L1", incoterm: "rfq:" + (state.incoterm || "DAP"), quantityBreaks: MODEL.breaks }),
    run: (runId) => {
      const r = costQuote(MODEL, state.incoterm || "DAP");
      state.quote = { breaks: r.breaks, runId };
      addNode("Q", "Quote Q-1002-A", "quote"); addEdge("Q", "RFQ-1002", "respondsTo");
      for (const b of r.breaks) { addNode("PB" + b.quantity, `Qty ${b.quantity.toLocaleString()}: $${fmt(b.unitPrice)}/u\ntotal $${fmt(b.total)}`, "price"); addEdge("Q", "PB" + b.quantity, "hasPriceBreak"); addEdge("PB" + b.quantity, "QB" + b.quantity, "forQuantityBreak"); }
      return { incoterm: r.incoterm + (r.sellerPays ? " (seller pays freight)" : " (buyer pays freight)"), breaks: r.breaks.map((b) => ({ quantity: b.quantity, unitPrice: b.unitPrice, extended: b.extended, nre: b.nre, freight: b.freight, total: b.total, cogs: +b.cogs.toFixed(4), loaded: +b.loaded.toFixed(6) })) };
    } },
  { stage: "cost", tool: "explain_quote", input: () => quoteForExplain(),
    run: async (runId, rec) => {
      const qi = quoteForExplain();
      const live = await liveTool(rec, "explain_quote", qi);
      const out = live || cannedExplain(qi);
      state.quote.explanation = { ...out, by: runId, live: !!live };
      return out;
    } },
  { stage: "approve", gate: true },
  { stage: "send", tool: "render_quote", input: () => ({ quote: "ex:Q-1002-A", approvedBy: state.approval?.by }),
    run: () => { addNode("SENT", "Quote sent (simulated)", "quote"); addEdge("Q", "SENT", "status"); return { document: "Q-1002-A.pdf (simulated)", sentTo: "Northwind purchasing (simulated: nothing left the browser)" }; } },
];

// ---------- live semantics (kb.js) ----------
async function shaclRun(fix, replay, rec) {
  if (kb.ready) {
    try {
      const r = await validateRFQ(fix);
      const agrees = JSON.stringify(r.results.map((x) => x.message)) === JSON.stringify(replay.results.map((x) => x.message)) && r.conforms === replay.conforms;
      rec.replay = false;
      return { conforms: r.conforms, results: r.results, engine: "shacl-engine 1.1.3 + N3.js, live in your browser", triplesValidated: r.triples, ms: r.ms,
        buildTimePySHACL: { conforms: replay.conforms, results: replay.results.map((x) => x.message), agrees } };
    } catch (e) { console.warn("live SHACL failed, falling back to replay", e); }
  }
  rec.replay = true;
  return { conforms: replay.conforms, results: replay.results, engine: "pySHACL (replayed from build time; browser SHACL unavailable)" };
}
function classify(rec) {
  const live = kb.ready ? completeRFQ() : null;
  const h = REASONER;
  state.reasoner = { live: live ? live.ask : null, liveMs: live?.ms, hermitBefore: h?.before.types, hermitAfter: h?.after.types, hermitEngine: h?.engine };
  rec.replay = !live;
  const inferred = live ? live.ask : !!h?.after.completeRFQ;
  if (inferred) {
    addNode("CLS-Complete", "rfq:CompleteRFQ\n(defined class)", "inferred");
    addEdge("RFQ-1002", "CLS-Complete", "rdf:type (inferred)", { dashes: true, color: { color: "#3fb27f" }, font: { color: "#3fb27f", size: 10, strokeWidth: 0 } });
    setNode("RFQ-1002", { label: "RFQ-1002 rev A\na rfq:RFQPackage\n⟹ rfq:CompleteRFQ (inferred)" });
  }
  return { individual: "ex:RFQ-1002", inferredType: inferred ? "rfq:CompleteRFQ" : null,
    liveCheck: live ? { engine: "Oxigraph SPARQL ASK of the CompleteRFQ definition (live)", result: live.ask, ms: live.ms, query: COMPLETE_RFQ_ASK } : "unavailable",
    hermit: h ? { engine: h.engine + " (replayed from build time)", before: h.before.types, after: h.after.types } : "unavailable" };
}
function plaMatch() {
  const fallback = { line: "ex:RFQ-1002-L1", product: "ex:BRK-100", score: "0.91", method: "llm:llama-3.3-70b (example)", confidence: "high", run: "ex:RUN-1002-4" };
  if (!kb.ready) return fallback;
  try { const r = sparql(kb.queries[12].text); const row = r.rows[0]; if (!row) return fallback;
    const o = Object.fromEntries(r.vars.map((v, i) => [v, row[i]])); return { ...o, source: "CQ12 (live SPARQL)" }; } catch { return fallback; }
}
// ---------- live AI tools (rfq-pla Worker) ----------
const RFQ_1003_EMAIL = `From: purchasing@northwind.example
Subject: RFQ-1003 rev A - BRK-300 welded bracket

Hello,

Please quote RFQ-1003 rev A for the BRK-300 welded mounting bracket per drawing BRK-300 rev A.
Material: ASTM A36 steel plate. Quantities: 250 and 2,500 pieces.
Delivery by 1 April 2027. Payment Net 30. We'd normally want it delivered to our dock (DAP?) but
logistics will confirm.

Thanks,
Northwind Agricultural Equipment`;
async function liveTool(rec, tool, input) {
  const key = `${state.runId}-${tool}`.replace(/[^\w-]/g, "-").slice(0, 64);
  const r = await runTool(tool, input, key);
  if (r.ok) { rec.live = { model: MODEL_LABEL, workerRunId: r.runId, ms: r.ms, polls: r.polls, workflow: r.workflow, deduplicated: r.deduplicated, usage: r.usage, attempts: r.attempts }; rec.liveInput = input; return r.output; }
  rec.fallback = { reason: r.reason, message: r.message, status: r.status ?? null, ms: r.ms };
  const verbatim = r.reason === "resting" || r.reason === "rate_limited";
  raiseIssue({ id: "API-" + r.reason, title: r.reason === "resting" ? r.message : r.reason === "unauthorized" ? "Session expired: reload and enter the secret again" : `Live model unavailable (${r.reason})`,
    detail: `${verbatim ? r.message + " " : r.reason === "unauthorized" ? r.message + " " : r.message + ". "}${tool} used its scripted output instead (badged "scripted (fallback)").`, owner: r.reason === "unauthorized" ? "human" : "PLA", kind: "api", resolved: true, resolution: "Fell back to scripted output" });
  if (r.reason === "resting") state.apiNotice = r.message; else if (r.reason === "unauthorized") state.apiNotice = r.message;
  return null;
}
function quoteForExplain() {
  return { quote: "Q-1002-A", product: "BRK-200 bracket (priced as BRK-100)", incoterm: state.incoterm || "DAP",
    breaks: (state.quote?.breaks || []).map((b) => ({ line: "L1", quantity: b.quantity, unit_price: b.unitPrice, nre: b.nre, freight: b.freight, total: b.total })) };
}
function cannedExplain(q) {
  const parts = q.breaks.map((b) => `${b.quantity.toLocaleString("en-US")} units at $${fmt(b.unit_price)} each (total $${fmt(b.total)})`);
  return { quote: q.quote, summary: `Quote ${q.quote}: ${parts.join("; ")}. The unit price falls with volume because setup cost is spread over more parts.`,
    drivers: ["Setup cost spread over the lot", "Material from library matches", `Freight under ${q.incoterm}`], breaks: parts, caveats: ["Scripted explanation (no model call)."] };
}
function currentFix() { return fixTurtle(state.fixes?.incoterm, state.fixes?.spec); }

// ---------- state ----------
function freshState() {
  const id = "RUN-" + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(2) + "-" + Math.random().toString(36).slice(2, 5);
  return { runId: id, startedAt: now(), endedAt: null, status: "running", step: 0, attempt: 0, nextAttemptAt: null, paused: false,
    stages: Object.fromEntries(STAGES.map((s) => [s, "pending"])), issues: [], runs: [], nodes: [], edges: [], quote: null,
    failArmed: false, failMode: "transient", failRemaining: 0, approval: null, awaiting: null, seq: 0 };
}
function save() { if (state) localStorage.setItem(KEY, JSON.stringify(state)); updateHistory(); }
function loadHistory() { try { return JSON.parse(localStorage.getItem(HKEY)) || []; } catch { return []; } }
function updateHistory() {
  if (!state) return; const h = loadHistory(); const total = state.quote ? state.quote.breaks.map((b) => b.total) : null;
  const rec = { runId: state.runId, startedAt: state.startedAt, status: state.status, totals: total };
  const i = h.findIndex((x) => x.runId === state.runId); if (i >= 0) h[i] = rec; else h.unshift(rec);
  localStorage.setItem(HKEY, JSON.stringify(h.slice(0, 20)));
}
function raiseIssue(iss) { if (!state.issues.find((i) => i.id === iss.id)) state.issues.push({ resolved: false, raisedAt: now(), ...iss }); }
function resolveIssue(id, resolution) { const i = state.issues.find((x) => x.id === id); if (i && !i.resolved) { i.resolved = true; i.resolution = resolution; i.resolvedAt = now(); } }

// ---------- runner ----------
async function loop() {
  const tok = ++loopToken;
  while (tok === loopToken && state && state.status === "running" && !state.paused) {
    if (state.step >= STEPS.length) { state.status = "sent"; state.endedAt = now(); save(); render(); break; }
    const st = STEPS[state.step];
    if (st.gate) { state.stages.approve = "blocked"; state.awaiting = "approval"; state.status = "awaiting"; save(); render(); break; }
    if (state.nextAttemptAt) { const w = state.nextAttemptAt - now(); if (w > 0) { await sleep(Math.min(w, 250)); continue; } state.nextAttemptAt = null; }
    state.stages[st.stage] = state.attempt > 0 ? "retrying" : "running"; render();
    await sleep(PACE); if (tok !== loopToken || state.paused || state.status !== "running") break;
    await execStep(st);
    if (tok !== loopToken) break;
  }
}
async function execStep(st) {
  state.attempt += 1;
  const runId = `TR-${String(++state.seq).padStart(3, "0")}`;
  const t0 = performance.now(), started = now();
  const rec = { id: runId, tool: st.tool, kind: TOOLS[st.tool].kind, canned: !!TOOLS[st.tool].canned, replay: !!TOOLS[st.tool].replay, stage: st.stage, attempt: state.attempt, startedAt: started, input: st.input() };
  await sleep(250 + Math.random() * 600); // simulated tool latency
  try {
    if (state.failArmed) { state.failArmed = false; state.failRemaining = state.failMode === "transient" ? 2 : 99; state.failTool = st.tool; }
    if (state.failRemaining > 0 && state.failTool === st.tool) { state.failRemaining -= 1; throw new Error(`Injected failure: ${st.tool} timed out (simulated)`); }
    const out = await st.run(runId, rec);
    rec.output = out; rec.ok = true; rec.durationMs = Math.round(performance.now() - t0); state.runs.push(rec);
    resolveIssue("FAIL-" + st.tool, `Recovered on attempt ${state.attempt}`);
    state.attempt = 0;
    const nxt = st.after ? st.after(out) : null;
    if (nxt === "awaitFixes") { state.stages[st.stage] = "blocked"; state.status = "blocked"; state.awaiting = "fixes"; }
    else { const later = STEPS.slice(state.step + 1).some((s) => s.stage === st.stage); if (!later) state.stages[st.stage] = "done"; state.step += 1; }
  } catch (e) {
    rec.ok = false; rec.error = e.message; rec.durationMs = Math.round(performance.now() - t0); state.runs.push(rec);
    raiseIssue({ id: "FAIL-" + st.tool, title: `${st.tool} failing`, detail: e.message, owner: "PLA", kind: "failure" });
    if (state.attempt < MAX_ATTEMPTS) {
      const backoff = BASE_BACKOFF * 2 ** (state.attempt - 1);
      rec.nextRetryInMs = backoff; state.nextAttemptAt = now() + backoff; state.stages[st.stage] = "retrying";
      const iss = state.issues.find((i) => i.id === "FAIL-" + st.tool); iss.detail = `${e.message}. Attempt ${state.attempt}/${MAX_ATTEMPTS}; retrying in ${backoff / 1000}s (exponential backoff).`;
    } else {
      state.stages[st.stage] = "failed"; state.status = "failed";
      const iss = state.issues.find((i) => i.id === "FAIL-" + st.tool); iss.owner = "human"; iss.detail = `${e.message}. ${MAX_ATTEMPTS} attempts exhausted. Use "Retry failed step".`;
    }
  }
  save(); render();
}

// ---------- actions ----------
function start() { if (kb.ready) resetStore(); state = freshState(); state.reasonerBefore = kb.ready ? completeRFQ().ask : null; save(); showConsole(); render(); loop(); }
function fixIssue(id) {
  const iss = state.issues.find((i) => i.id === id);
  state.fixes = state.fixes || {};
  if (iss.kind === "HasIncoterm") { const v = document.querySelector(`[data-sel="${id}"]`).value; resolveIssue(id, `Incoterm set to ${v} (human)`); addNode("INCO", `Incoterm ${v}`, "terms"); addEdge("DT", "INCO", "hasIncoterm"); state.incoterm = v; state.fixes.incoterm = v; }
  if (iss.kind === "HasMaterialOrFinishSpec") { resolveIssue(id, "Material spec ASTM A36 added (human)"); addNode("SPEC", "MaterialSpec ASTM A36", "doc"); addEdge("RFQ-1002", "SPEC", "hasTechnicalRequirement"); state.fixes.spec = true; }
  state.fixTurtle = currentFix(); if (kb.ready) applyFix(state.fixTurtle);
  if (state.issues.filter((i) => i.id.startsWith("SH-")).every((i) => i.resolved) && state.awaiting === "fixes") {
    state.awaiting = null; state.status = "running"; state.stages.validate = "running"; state.step += 1;
  }
  save(); render(); loop();
}
function approve(ok) {
  if (ok) { state.approval = { by: "human reviewer", at: now(), decision: "approved" }; state.stages.approve = "done"; state.status = "running"; state.awaiting = null; state.step += 1; save(); render(); loop(); }
  else { state.approval = { by: "human reviewer", at: now(), decision: "rejected" }; state.stages.approve = "failed"; state.status = "rejected"; state.endedAt = now(); state.awaiting = null;
    raiseIssue({ id: "REJECTED", title: "Quote rejected at approval gate", detail: "The PLA stops; nothing is sent.", owner: "human", kind: "note" }); save(); render(); }
}
function retryFailed() { if (state.status !== "failed") return; state.status = "running"; state.attempt = 0; state.failRemaining = 0; state.nextAttemptAt = null;
  resolveIssue(state.issues.find((i) => i.kind === "failure" && !i.resolved)?.id, "Manual retry requested"); save(); render(); loop(); }

// ---------- rendering ----------
const GROUPS = { rfq: "#4da3ff", party: "#8593a3", terms: "#3fb2c9", doc: "#e0a63a", line: "#6e7fd6", qty: "#5a6b80", bom: "#7a8fa6", match: "#a371f7", lib: "#c69026", rate: "#3fb27f", quote: "#e5534b", price: "#f08b5a", product: "#5fb3a8", plamatch: "#d46ee8", inferred: "#3fb27f" };
function renderGraph() {
  if (!window.vis) { $("graph").innerHTML = '<p class="muted">Graph library failed to load.</p>'; return; }
  if (!net) {
    nodesDS = new vis.DataSet(); edgesDS = new vis.DataSet();
    net = new vis.Network($("graph"), { nodes: nodesDS, edges: edgesDS }, {
      nodes: { shape: "box", font: { color: "#0b0f14", size: 11, multi: false }, margin: 6, borderWidth: 0 },
      edges: { arrows: "to", font: { size: 9, color: "#8593a3", strokeWidth: 0 }, color: "#3a4553", smooth: { type: "dynamic" } },
      physics: { solver: "forceAtlas2Based", forceAtlas2Based: { gravitationalConstant: -60, springLength: 90 }, stabilization: { iterations: 80 } }, interaction: { hover: true } });
  }
  let changed = false;
  for (const n of state.nodes) { const cur = nodesDS.get(n.id), v = { ...n, color: { background: GROUPS[n.group] || "#888" }, ...(n.group === "plamatch" ? { borderWidth: 2, shapeProperties: { borderDashes: false } } : {}), ...(n.group === "inferred" ? { shapeProperties: { borderDashes: [4, 3] }, borderWidth: 2, color: { background: "#123d2a", border: "#3fb27f" }, font: { color: "#93e6bd", size: 11 } } : {}) };
    if (!cur) { nodesDS.add(v); changed = true; } else if (cur.label !== n.label) nodesDS.update(v); }
  for (const e of state.edges) if (!edgesDS.get(e.id)) edgesDS.add(e);
  for (const id of nodesDS.getIds()) if (!state.nodes.find((n) => n.id === id)) nodesDS.remove(id);
  if (changed) { clearTimeout(renderGraph.t); renderGraph.t = setTimeout(() => net && net.fit({ animation: false }), 900); }
}
function render() {
  if (!state) return;
  $("hdr").hidden = false;
  const cur = STEPS[Math.min(state.step, STEPS.length - 1)].stage;
  $("h-stage").textContent = state.status === "sent" ? "complete" : cur;
  const label = state.paused ? "paused" : { running: "running", blocked: "blocked: needs human", awaiting: "awaiting approval", failed: "failed", sent: "quote sent", rejected: "rejected" }[state.status];
  $("h-status").textContent = label; $("h-status").className = "badge " + (state.paused ? "paused" : state.status === "sent" ? "done" : state.status);
  $("h-run").textContent = state.runId;
  $("pipeline").innerHTML = STAGES.map((s) => `<li class="${state.stages[s]}" data-stage="${s}"><div class="n">${s}</div><div class="s">${state.stages[s]}</div></li>`).join("");
  $("btn-pause").textContent = state.paused ? "Resume" : "Pause";
  $("btn-pause").disabled = !["running", "blocked", "awaiting"].includes(state.status) && !state.paused;
  $("btn-retry").disabled = state.status !== "failed";
  $("tog-fail").checked = state.failArmed; $("fail-mode").value = state.failMode;
  // issues
  const open = state.issues.filter((i) => !i.resolved).length; $("issue-count").textContent = open + " open";
  $("issues").innerHTML = state.issues.length ? state.issues.slice().reverse().map((i) => `<div class="issue ${i.resolved ? "resolved" : ""}" data-issue="${i.id}">
    <div class="t">${esc(i.title)} <span class="own ${i.owner}">${i.owner}</span></div><div class="m">${esc(i.detail)}</div>
    ${i.resolved ? `<div class="m">✓ ${esc(i.resolution || "resolved")}</div>` :
      i.kind === "HasIncoterm" ? `<select data-sel="${i.id}"><option>DAP</option><option>FCA</option><option>EXW</option><option>DDP</option></select> <button class="primary" data-fix="${i.id}">Resolve</button>` :
      i.kind === "HasMaterialOrFinishSpec" ? `<button class="primary" data-fix="${i.id}">Add spec: ASTM A36 steel plate</button>` : ""}</div>`).join("") : '<p class="muted">No issues yet.</p>';
  // log
  const pend = state.status === "running" && state.step < STEPS.length && !STEPS[state.step].gate ? `<div class="run pending"><summary><span class="nm">${STEPS[state.step].tool}</span>${badges(STEPS[state.step].tool)}<span class="r">${state.nextAttemptAt ? "waiting to retry…" : "running…"}</span></summary></div>` : "";
  $("log").innerHTML = pend + state.runs.slice().reverse().map((r) => `<details class="run ${r.ok ? "ok" : "err"}"><summary><span class="nm">${r.id} · ${r.tool}</span>${badges(r.tool, r)}<span class="r">${r.ok ? "ok" : "error"} · attempt ${r.attempt} · ${r.durationMs} ms</span></summary>
    <div class="body"><div class="muted">${esc(TOOLS[r.tool].desc)} · stage ${r.stage} · ${new Date(r.startedAt).toLocaleTimeString()}</div>
    ${r.error ? `<p style="color:#ffb4ae">${esc(r.error)}${r.nextRetryInMs ? ` · next retry in ${r.nextRetryInMs / 1000}s` : ""}</p>` : ""}
    ${r.fallback ? `<p class="fbmsg">Scripted fallback: ${esc(r.fallback.message)}</p>` : ""}
    <pre>${esc(JSON.stringify({ toolRun: r.id, tool: r.tool, kind: r.kind, canned: r.canned && !r.live, live: r.live || null, fallback: r.fallback || null, replayed: !!r.replay, liveInBrowser: !!TOOLS[r.tool].live && !r.replay, attempt: r.attempt, input: r.input, output: r.output ?? null, error: r.error ?? null }, null, 2))}</pre></div></details>`).join("");
  renderQuote(); renderGraph(); renderHistory(); renderReasoner();
  $("api-notice").hidden = !state.apiNotice; if (state.apiNotice) $("api-notice").textContent = state.apiNotice;
  $("banner").hidden = !state._resumed; if (state._resumed) $("banner").textContent = `Resumed ${state.runId} from saved state after a page reload (step ${state.step + 1} of ${STEPS.length}).`;
}
const ROWS = [["material", "Material"], ["conversion", "Conversion"], ["cogs", "COGS"], ["overhead", "Overhead 12%"], ["sga", "SG&A 10%"], ["loaded", "Loaded cost"], ["unitPrice", "Unit price"], ["extended", "Extended"], ["nre", "NRE"], ["freight", "Freight"], ["total", "Total"]];
function renderQuote() {
  if (!state.quote) { $("quote").innerHTML = '<p class="muted">Not costed yet.</p>'; $("gate").innerHTML = ""; return; }
  const B = state.quote.breaks;
  $("quote").innerHTML = `<table><tr><th>USD (Q-1002-A)</th>${B.map((b) => `<th>Qty ${b.quantity.toLocaleString()}</th>`).join("")}</tr>` +
    ROWS.map(([k, l]) => `<tr class="${k === "total" || k === "unitPrice" ? "tot" : ""}"><td>${l}</td>${B.map((b, i) => `<td class="pv" data-pv="${k}:${i}">${fmt(b[k], ["unitPrice", "extended", "nre", "freight", "total"].includes(k) ? 2 : 4)}</td>`).join("")}</tr>`).join("") +
    `</table><p class="muted" style="font-size:12px">Computed live in your browser by cost_quote (${state.quote.runId}). Unit price = loaded ÷ (1 − 25%), rounded half-up to the cent.</p>` +
    (state.quote.explanation ? `<div class="explain" id="explain"><b>Explanation</b> ${state.quote.explanation.live ? `<span class="b live">live · ${MODEL_LABEL}</span>` : '<span class="b canned">scripted (fallback)</span>'} <span class="muted">(${state.quote.explanation.by})</span><p>${esc(state.quote.explanation.summary)}</p>${state.quote.explanation.drivers?.length ? `<ul>${state.quote.explanation.drivers.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}</div>` : "");
  if (state.awaiting === "approval") $("gate").innerHTML = `<div class="gate"><b>Human approval gate.</b> The PLA proposes this quote and waits. Agents propose, people approve.<div class="act"><button class="primary" id="btn-approve">Approve &amp; send</button><button class="danger" id="btn-reject">Reject</button></div></div>`;
  else if (state.approval) $("gate").innerHTML = `<div class="gate">Quote <b>${state.approval.decision}</b> by ${state.approval.by} at ${new Date(state.approval.at).toLocaleTimeString()}.${state.status === "sent" ? " Sent (simulated; nothing left the browser)." : ""}</div>`;
  else $("gate").innerHTML = "";
}
function provenance(k, i) {
  const b = state.quote.breaks[i], r = costQuote(MODEL, "DAP"), q = b.quantity, M = MODEL;
  const runs = (t) => state.runs.filter((x) => x.tool === t && x.ok).map((x) => x.id).join(", ");
  const rateLi = r.convLines.map((c) => `<li>${c.line} op ${c.op} @ ${c.wc} $${c.rate}/h (labor ${c.labor} + machine ${c.machine} + burden ${c.burden}). Source: ${c.source}, effective ${c.effective}. Setup ${fmt(c.setupCost)} per lot, run ${fmt(c.runCost)} per unit.</li>`).join("");
  const matLi = r.matLines.map((m) => `<li>${m.line}: ${m.formula} = ${fmt(m.amount, 4)} (${m.source})</li>`).join("");
  const P = {
    material: [`Σ qty × unit cost × (1 + scrap) = ${fmt(b.material, 4)}`, `<ul>${matLi}</ul>Unit costs come from the similarity matches (${runs("match_library_part")}).`],
    conversion: [`setup per lot ÷ Q + run per unit = ${fmt(r.setupPerLot)} ÷ ${q.toLocaleString()} + ${fmt(r.runPerUnit)} = ${fmt(b.conversion, 4)}`, `<ul>${rateLi}</ul>Routings from explode_bom (${runs("explode_bom")}).`],
    cogs: [`material + conversion = ${fmt(b.material, 4)} + ${fmt(b.conversion, 4)} = ${fmt(b.cogs, 4)}`, ""],
    overhead: [`COGS × ${M.overhead.value} = ${fmt(b.overhead, 4)}`, `Source: ${M.overhead.source}, effective ${M.overhead.effective}.`],
    sga: [`COGS × ${M.sga.value} = ${fmt(b.sga, 4)}`, `Source: ${M.sga.source}, effective ${M.sga.effective}.`],
    loaded: [`COGS × (1 + 0.12 + 0.10) = ${fmt(b.loaded, 6)}`, ""],
    unitPrice: [`loaded ÷ (1 − ${M.margin.value}) = ${fmt(b.loaded / (1 - M.margin.value), 6)} → ${fmt(b.unitPrice)}`, `Margin source: ${M.margin.source}, effective ${M.margin.effective}. Margin is on price.`],
    extended: [`unit price × Q = ${fmt(b.unitPrice)} × ${q.toLocaleString()} = ${fmt(b.extended)}`, ""],
    nre: [`Σ NRE = ${fmt(b.nre)}`, `<ul>${M.nre.map((n) => `<li>${n.label}: ${fmt(n.amount)}</li>`).join("")}</ul>`],
    freight: [`${M.freight.perUnit} × ${q.toLocaleString()} = ${fmt(b.freight)}`, `${["DAP","DDP"].includes(state.incoterm || "DAP") ? "Seller pays" : "Buyer pays (0)"} freight under ${state.incoterm || "DAP"} (Incoterm fixed by the human in the issues panel). Source: ${M.freight.source}, effective ${M.freight.effective}.`],
    total: [`extended + NRE + freight = ${fmt(b.extended)} + ${fmt(b.nre)} + ${fmt(b.freight)} = ${fmt(b.total)}`, ""],
  }[k];
  openDrawer(`<h2>${ROWS.find((x) => x[0] === k)[1]} · Qty ${q.toLocaleString()}</h2><div class="chain">${P[0]}</div>${P[1] ? `<h3>Derived from</h3>${P[1]}` : ""}
    <h3>Produced by</h3><p>Tool run <b>${state.quote.runId}</b> · cost_quote <span class="b det">deterministic</span>, quote date ${M.quoteDate}.</p>`);
}
function renderReasoner() {
  const r = state.reasoner, h = REASONER;
  const liveBefore = state.reasonerBefore;
  const row = (label, badge, before, after) => `<tr><td>${label} ${badge}</td><td>${before}</td><td>${after}</td></tr>`;
  const t = (x) => x == null ? '<span class="muted">–</span>' : x ? '<b class="okc">CompleteRFQ ✓</b>' : '<span class="muted">RFQPackage only</span>';
  $("reasoner").innerHTML = `<table class="rt"><tr><th>Check</th><th>Before fix</th><th>After fix</th></tr>
    ${row("SPARQL ASK of the OWL definition (Oxigraph)", '<span class="b live">live</span>', t(liveBefore), t(r ? r.live : null))}
    ${row(`HermiT via ROBOT`, '<span class="b replay">replayed</span>', h ? t(h.before.completeRFQ) : "n/a", h ? (r ? t(h.after.completeRFQ) : '<span class="muted">(after fix)</span>') : "n/a")}
    </table>
    <p class="muted" style="font-size:12px">${r && r.live ? '<span class="b inf">inferred</span> RFQ-1002 is now classified as <code>rfq:CompleteRFQ</code>. Nobody asserted that type: it follows from the class definition once the missing facts (Incoterm, material spec) arrive.' : "RFQ-1002 is only an <code>rfq:RFQPackage</code> until the missing facts arrive. Under the open-world assumption the reasoner never says it is <i>incomplete</i>; SHACL does that."}
    HermiT cannot run in a browser, so its result is a build-time replay (${esc(h?.engine || "unavailable")}, DAP fix). The live check is a SPARQL ASK that mirrors the definition on asserted data.</p>
    <details><summary class="muted" style="cursor:pointer;font-size:12px">Show the ASK query</summary><pre class="q">${esc(COMPLETE_RFQ_ASK)}</pre></details>`;
}
function initSparql() {
  const sel = $("cq-sel");
  if (!kb.ready) { $("sparql-body").innerHTML = `<p class="muted">SPARQL engine failed to load (${esc(kb.error || "unknown")}).</p>`; return; }
  sel.innerHTML = QUERIES.map((n) => `<option value="${n}">CQ${n}: ${esc(kb.queries[n].title.replace(/^CQ\d+:\s*/, ""))}</option>`).join("");
  const show = () => { const q = kb.queries[sel.value]; $("cq-text").textContent = q.text; $("cq-file").textContent = "queries/" + q.file; $("cq-out").innerHTML = ""; };
  sel.addEventListener("change", show); show();
}
function runSparql() {
  const q = kb.queries[$("cq-sel").value];
  try {
    const r = sparql(q.text);
    $("cq-out").innerHTML = `<p class="muted" style="font-size:12px">${r.rows.length} row${r.rows.length === 1 ? "" : "s"} · ${r.ms} ms · Oxigraph, live in your browser over ${kb.store.size.toLocaleString()} triples${kb.fix ? " (including the human fix)" : ""}</p>` +
      (r.rows.length ? `<table class="sq"><tr>${r.vars.map((v) => `<th>?${esc(v)}</th>`).join("")}</tr>${r.rows.map((row) => `<tr>${row.map((c) => `<td>${c == null ? '<span class="muted">–</span>' : esc(c)}</td>`).join("")}</tr>`).join("")}</table>` : '<p class="muted">No rows.</p>');
  } catch (e) { $("cq-out").innerHTML = `<p style="color:#ffb4ae">${esc(e.message || e)}</p>`; }
}
function renderHistory() {
  const h = loadHistory();
  const html = h.length ? h.map((x) => `<div class="hist"><span>${x.runId}</span><span class="badge ${x.status === "sent" ? "done" : x.status}">${x.status}</span>${x.totals ? `<span>$${fmt(x.totals[0])} / $${fmt(x.totals[1])} / $${fmt(x.totals[2])}</span>` : ""}<span class="when">${new Date(x.startedAt).toLocaleString()}</span></div>`).join("") : '<p class="muted">No runs yet.</p>';
  $("history").innerHTML = html; $("landing-history").innerHTML = h.length ? `<h3 class="muted">Past runs</h3>${html}` : "";
}
function openDrawer(html) { $("drawer-body").innerHTML = html; $("drawer").hidden = false; }
function showConsole() { $("landing").hidden = true; $("console").hidden = false; }
function tick() { if (!state) return; const e = Math.floor(((state.endedAt || now()) - state.startedAt) / 1000); $("h-elapsed").textContent = `${Math.floor(e / 60)}:${String(e % 60).padStart(2, "0")}`; }

// ---------- wiring ----------
document.addEventListener("click", (ev) => {
  const t = ev.target;
  if (t.id === "btn-upload") { if (SHACL) start(); }
  else if (t.id === "btn-new") { if (state && ["running", "blocked", "awaiting"].includes(state.status)) { state.status = "abandoned"; state.endedAt = now(); updateHistory(); } loopToken++; localStorage.removeItem(KEY); state = null; net?.destroy(); net = null; $("console").hidden = true; $("landing").hidden = false; $("hdr").hidden = true; renderHistory(); }
  else if (t.id === "btn-pause") { state.paused = !state.paused; state._resumed = false; save(); render(); if (!state.paused) loop(); }
  else if (t.id === "btn-retry") retryFailed();
  else if (t.id === "btn-approve") approve(true);
  else if (t.id === "btn-reject") approve(false);
  else if (t.dataset.fix) fixIssue(t.dataset.fix);
  else if (t.dataset.pv) { const [k, i] = t.dataset.pv.split(":"); provenance(k, +i); }
  else if (t.id === "btn-about") openDrawer($("about-tpl").innerHTML);
  else if (t.id === "cq-run") runSparql();
  else if (t.id === "drawer-x") $("drawer").hidden = true;
});
$("tog-fail").addEventListener("change", (e) => { if (state) { state.failArmed = e.target.checked; save(); } });
$("fail-mode").addEventListener("change", (e) => { if (state) { state.failMode = e.target.value; save(); } });
setInterval(tick, 500);

(async function init() {
  $("btn-upload").disabled = true;
  [SHACL, REASONER] = await Promise.all([fetch("data/shacl-results.json").then((r) => r.json()), fetch("data/reasoner-results.json").then((r) => r.json()).catch(() => null)]);
  try { await loadKB(); } catch (e) { kb.error = String(e.message || e); console.warn("knowledge base failed to load; SHACL falls back to replay", e); }
  window.__pla.ready = true;
  $("btn-upload").disabled = false;
  try { state = JSON.parse(localStorage.getItem(KEY)); } catch { state = null; }
  if (state && state.fixTurtle && kb.ready) applyFix(state.fixTurtle);
  initSparql();
  if (state && state.runId) { state._resumed = ["running", "blocked", "awaiting", "failed"].includes(state.status); showConsole(); render(); loop(); }
  else { state = null; renderHistory(); }
})();
