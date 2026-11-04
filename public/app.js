import { MODEL, costQuote } from "./cost.js";

const KEY = "rfqdemo.run.v1", HKEY = "rfqdemo.history.v1";
const STAGES = ["intake", "validate", "match", "cost", "approve", "send"];
const MAX_ATTEMPTS = 4, BASE_BACKOFF = 1000, PACE = 900;
const $ = (id) => document.getElementById(id);
const fmt = (x, d = 2) => x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

window.__pla = { get state() { return state; } };
let SHACL = null, state = null, loopToken = 0, net = null, nodesDS = null, edgesDS = null;

// ---------- tools ----------
const TOOLS = {
  parse_rfq_document: { kind: "ai", canned: true, desc: "RFQ package (email + drawing PDF) to draft RFQ facts" },
  validate_rfq: { kind: "det", replay: true, desc: "SHACL completeness check (shapes/rfq-completeness.ttl)" },
  match_library_part: { kind: "ai", canned: true, desc: "Match each BOM line to a library entry; record score + method" },
  explode_bom: { kind: "det", desc: "Expand the matched BOM and routings into cost drivers" },
  cost_quote: { kind: "det", desc: "Cost calculator (JS port of scripts/quote.py), one price per quantity break" },
  render_quote: { kind: "det", desc: "Render the approved quote document" },
};
function badges(tool) {
  const t = TOOLS[tool]; let h = t.kind === "ai" ? '<span class="b ai">AI</span>' : '<span class="b det">deterministic</span>';
  if (t.canned) h += '<span class="b canned">canned</span>';
  if (t.replay) h += '<span class="b replay">replayed</span>';
  return h;
}

// ---------- graph helpers ----------
function addNode(id, label, group, title) { if (!state.nodes.find((n) => n.id === id)) state.nodes.push({ id, label, group, title: title || label }); }
function addEdge(from, to, label) { const id = `${from}|${label}|${to}`; if (!state.edges.find((e) => e.id === id)) state.edges.push({ id, from, to, label }); }

// ---------- PLA plan (each step = one tool call or one gate) ----------
const STEPS = [
  { stage: "intake", tool: "parse_rfq_document", input: () => ({ package: "RFQ-1002 package (sample)", files: ["RFQ-1002 email.eml", "DWG-BRK-200 rev A.pdf"] }),
    run: () => {
      addNode("RFQ-1002", "RFQ-1002 rev A", "rfq"); addNode("NORTHWIND", "Northwind Agricultural Equipment", "party"); addEdge("RFQ-1002", "NORTHWIND", "issuedBy");
      addNode("CT", "Commercial terms\nNet 30", "terms"); addEdge("RFQ-1002", "CT", "hasCommercialTerms");
      addNode("DT", "Delivery terms\n2027-03-01", "terms"); addEdge("RFQ-1002", "DT", "hasDeliveryTerms");
      addNode("DWG", "Drawing BRK-200 rev A", "doc"); addEdge("RFQ-1002", "DWG", "hasTechnicalRequirement");
      addNode("L1", "Line 1: BRK-200 bracket", "line"); addEdge("RFQ-1002", "L1", "hasLine");
      for (const q of MODEL.breaks) { addNode("QB" + q, "Qty " + q.toLocaleString(), "qty"); addEdge("L1", "QB" + q, "hasQuantityBreak"); }
      return { rfq: "ex:RFQ-1002", revision: "A", issuedBy: "ex:NORTHWIND", paymentTerms: "Net 30", requestedDeliveryDate: "2027-03-01T00:00:00", drawing: "ex:DWG-BRK-200",
        line: { product: "BRK-200 bracket", quantityBreaks: MODEL.breaks }, incoterm: null, materialSpec: null,
        lowConfidence: [], note: "Canned output: no model was called in v1." };
    } },
  { stage: "validate", tool: "validate_rfq", input: () => ({ focus: "ex:RFQ-1002", shapes: "shapes/rfq-completeness.ttl" }),
    run: () => {
      const r = SHACL.before;
      for (const v of r.results) raiseIssue({ id: "SH-" + v.shape, title: v.message, detail: `SHACL shape shp:${v.shape} failed on ex:${v.focus}`, owner: "human", kind: v.shape });
      return { conforms: r.conforms, results: r.results, engine: "pySHACL (replayed from build time)" };
    },
    after: (out) => out.conforms ? null : "awaitFixes" },
  { stage: "validate", tool: "validate_rfq", input: () => ({ focus: "ex:RFQ-1002", shapes: "shapes/rfq-completeness.ttl", addedFacts: SHACL.fixTurtle.split("\n").filter((l) => l.startsWith("ex:")) }),
    run: () => ({ conforms: SHACL.after.conforms, results: SHACL.after.results, engine: "pySHACL (replayed from build time)", classifiedAs: "rfq:CompleteRFQ" }) },
  { stage: "match", tool: "match_library_part", input: () => ({ product: "BRK-200 bracket", bomLines: MODEL.bom.map((b) => b.id) }),
    run: () => {
      addNode("BOM", "EBOM (as BRK-100)", "line"); addEdge("L1", "BOM", "forProduct/hasBOM");
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
      return { matches: out, note: "Canned output: no model was called in v1." };
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
  { stage: "approve", gate: true },
  { stage: "send", tool: "render_quote", input: () => ({ quote: "ex:Q-1002-A", approvedBy: state.approval?.by }),
    run: () => { addNode("SENT", "Quote sent (simulated)", "quote"); addEdge("Q", "SENT", "status"); return { document: "Q-1002-A.pdf (simulated)", sentTo: "Northwind purchasing (simulated: nothing left the browser)" }; } },
];

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
    const out = st.run(runId);
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
function start() { state = freshState(); save(); showConsole(); render(); loop(); }
function fixIssue(id) {
  const iss = state.issues.find((i) => i.id === id);
  if (iss.kind === "HasIncoterm") { const v = document.querySelector(`[data-sel="${id}"]`).value; resolveIssue(id, `Incoterm set to ${v} (human)`); addNode("INCO", `Incoterm ${v}`, "terms"); addEdge("DT", "INCO", "hasIncoterm"); state.incoterm = v; }
  if (iss.kind === "HasMaterialOrFinishSpec") { resolveIssue(id, "Material spec ASTM A36 added (human)"); addNode("SPEC", "MaterialSpec ASTM A36", "doc"); addEdge("RFQ-1002", "SPEC", "hasTechnicalRequirement"); }
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
const GROUPS = { rfq: "#4da3ff", party: "#8593a3", terms: "#3fb2c9", doc: "#e0a63a", line: "#6e7fd6", qty: "#5a6b80", bom: "#7a8fa6", match: "#a371f7", lib: "#c69026", rate: "#3fb27f", quote: "#e5534b", price: "#f08b5a" };
function renderGraph() {
  if (!window.vis) { $("graph").innerHTML = '<p class="muted">Graph library failed to load.</p>'; return; }
  if (!net) {
    nodesDS = new vis.DataSet(); edgesDS = new vis.DataSet();
    net = new vis.Network($("graph"), { nodes: nodesDS, edges: edgesDS }, {
      nodes: { shape: "box", font: { color: "#0b0f14", size: 11, multi: false }, margin: 6, borderWidth: 0 },
      edges: { arrows: "to", font: { size: 9, color: "#8593a3", strokeWidth: 0 }, color: "#3a4553", smooth: { type: "dynamic" } },
      physics: { solver: "forceAtlas2Based", forceAtlas2Based: { gravitationalConstant: -60, springLength: 90 }, stabilization: { iterations: 80 } }, interaction: { hover: true } });
  }
  for (const n of state.nodes) if (!nodesDS.get(n.id)) nodesDS.add({ ...n, color: { background: GROUPS[n.group] || "#888" } });
  for (const e of state.edges) if (!edgesDS.get(e.id)) edgesDS.add(e);
  for (const id of nodesDS.getIds()) if (!state.nodes.find((n) => n.id === id)) nodesDS.remove(id);
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
  $("log").innerHTML = pend + state.runs.slice().reverse().map((r) => `<details class="run ${r.ok ? "ok" : "err"}"><summary><span class="nm">${r.id} · ${r.tool}</span>${badges(r.tool)}<span class="r">${r.ok ? "ok" : "error"} · attempt ${r.attempt} · ${r.durationMs} ms</span></summary>
    <div class="body"><div class="muted">${esc(TOOLS[r.tool].desc)} · stage ${r.stage} · ${new Date(r.startedAt).toLocaleTimeString()}</div>
    ${r.error ? `<p style="color:#ffb4ae">${esc(r.error)}${r.nextRetryInMs ? ` · next retry in ${r.nextRetryInMs / 1000}s` : ""}</p>` : ""}
    <pre>${esc(JSON.stringify({ toolRun: r.id, tool: r.tool, kind: r.kind, canned: r.canned, replayed: r.replay, attempt: r.attempt, input: r.input, output: r.output ?? null, error: r.error ?? null }, null, 2))}</pre></div></details>`).join("");
  renderQuote(); renderGraph(); renderHistory();
  $("banner").hidden = !state._resumed; if (state._resumed) $("banner").textContent = `Resumed ${state.runId} from saved state after a page reload (step ${state.step + 1} of ${STEPS.length}).`;
}
const ROWS = [["material", "Material"], ["conversion", "Conversion"], ["cogs", "COGS"], ["overhead", "Overhead 12%"], ["sga", "SG&A 10%"], ["loaded", "Loaded cost"], ["unitPrice", "Unit price"], ["extended", "Extended"], ["nre", "NRE"], ["freight", "Freight"], ["total", "Total"]];
function renderQuote() {
  if (!state.quote) { $("quote").innerHTML = '<p class="muted">Not costed yet.</p>'; $("gate").innerHTML = ""; return; }
  const B = state.quote.breaks;
  $("quote").innerHTML = `<table><tr><th>USD (Q-1002-A)</th>${B.map((b) => `<th>Qty ${b.quantity.toLocaleString()}</th>`).join("")}</tr>` +
    ROWS.map(([k, l]) => `<tr class="${k === "total" || k === "unitPrice" ? "tot" : ""}"><td>${l}</td>${B.map((b, i) => `<td class="pv" data-pv="${k}:${i}">${fmt(b[k], ["unitPrice", "extended", "nre", "freight", "total"].includes(k) ? 2 : 4)}</td>`).join("")}</tr>`).join("") +
    `</table><p class="muted" style="font-size:12px">Computed live in your browser by cost_quote (${state.quote.runId}). Unit price = loaded ÷ (1 − 25%), rounded half-up to the cent.</p>`;
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
  else if (t.id === "drawer-x") $("drawer").hidden = true;
});
$("tog-fail").addEventListener("change", (e) => { if (state) { state.failArmed = e.target.checked; save(); } });
$("fail-mode").addEventListener("change", (e) => { if (state) { state.failMode = e.target.value; save(); } });
setInterval(tick, 500);

(async function init() {
  $("btn-upload").disabled = true;
  SHACL = await (await fetch("data/shacl-results.json")).json();
  $("btn-upload").disabled = false;
  try { state = JSON.parse(localStorage.getItem(KEY)); } catch { state = null; }
  if (state && state.runId) { state._resumed = ["running", "blocked", "awaiting", "failed"].includes(state.status); showConsole(); render(); loop(); }
  else { state = null; renderHistory(); }
})();
