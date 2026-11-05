// PCAQ viewer: Oxigraph (SPARQL, WASM) + shacl-engine + vis-network, all in-browser, local files only.
import initOx, * as ox from "./vendor/oxigraph/web.js";
import { Parser, rdf, Validator } from "./vendor/rdf-shacl.js";

const FILES = ["pcaq.ttl", "pcaq-demo.ttl"];
const SHAPES = "pcaq-shapes.ttl";
const PFX = { pcaq: "http://pcaq.local/ns#", ex: "http://pcaq.local/demo#", owl: "http://www.w3.org/2002/07/owl#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#", rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#", xsd: "http://www.w3.org/2001/XMLSchema#",
  prov: "http://www.w3.org/ns/prov#", sh: "http://www.w3.org/ns/shacl#" };
const PREFIXES = Object.entries(PFX).map(([k, v]) => `PREFIX ${k}: <${v}>`).join("\n") + "\n";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const short = (iri) => { for (const [k, v] of Object.entries(PFX)) if (iri.startsWith(v)) return k + ":" + iri.slice(v.length); return iri; };

let store, texts = {}, extra = [], queries = [], lastResult = null, treeMode = "class", net, nodes, edges;

async function fetchText(p) { const r = await fetch("data/" + p); if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`); return r.text(); }

function select(q) {
  const r = store.query(PREFIXES + q);
  if (typeof r === "boolean") return { ask: r };
  const vars = r.length ? [...r[0].keys()] : [];
  return { vars, rows: r.map((m) => Object.fromEntries(vars.map((v) => [v, m.get(v)]))) };
}
const label = (iri) => { const r = select(`SELECT ?l WHERE { <${iri}> rdfs:label ?l } LIMIT 1`).rows; return r.length ? r[0].l.value : short(iri); };

function buildStore() {
  store = new ox.Store();
  for (const f of FILES) store.load(texts[f], { format: "text/turtle", base_iri: "http://pcaq.local/" });
  for (const t of extra) store.load(t.text, { format: "text/turtle", base_iri: "http://pcaq.local/" });
  const c = select(`SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE { ?c a owl:Class FILTER isIRI(?c) }`).rows[0].n.value;
  const i = select(`SELECT (COUNT(DISTINCT ?i) AS ?n) WHERE { ?i a ?c . ?c a owl:Class . FILTER(?c NOT IN (owl:Class)) FILTER STRSTARTS(STR(?i), "${PFX.ex}") }`).rows[0].n.value;
  $("stats").textContent = `${store.size} triples · ${c} classes · ${i} demo individuals · files: ${[...FILES, ...extra.map((e) => e.name)].join(", ")}`;
  renderTree();
}

// ---------- left tree ----------
function renderTree() {
  const f = $("filter").value.toLowerCase();
  if (treeMode === "class") {
    const rows = select(`SELECT ?c ?p (COUNT(DISTINCT ?i) AS ?n) WHERE { ?c a owl:Class FILTER isIRI(?c)
      OPTIONAL { ?c rdfs:subClassOf ?p FILTER isIRI(?p) } OPTIONAL { ?s rdfs:subClassOf* ?c . ?i a ?s } } GROUP BY ?c ?p`).rows;
    const kids = {}, all = new Map();
    for (const r of rows) { const c = r.c.value, p = r.p && all !== null ? r.p.value : null; all.set(c, +r.n.value); (kids[p && rows.some((x) => x.c.value === p) ? p : "ROOT"] ||= []).push(c); }
    const node = (c) => { const ch = (kids[c] || []).sort((a, b) => label(a).localeCompare(label(b)));
      const sub = ch.map(node).filter(Boolean).join(""); const l = label(c);
      if (f && !l.toLowerCase().includes(f) && !short(c).toLowerCase().includes(f) && !sub) return "";
      return `<li><span data-iri="${esc(c)}">${esc(l)}<span class="cnt">${all.get(c) || ""}</span></span>${sub ? `<ul>${sub}</ul>` : ""}</li>`; };
    $("tree").innerHTML = `<ul>${[...new Set(kids.ROOT || [])].sort((a, b) => label(a).localeCompare(label(b))).map(node).join("")}</ul>`;
  } else {
    const rows = select(`SELECT ?i ?l ?t WHERE { ?i a ?c . ?c a owl:Class FILTER isIRI(?i) FILTER(!STRSTARTS(STR(?i), "${PFX.pcaq}"))
      OPTIONAL { ?i rdfs:label ?l } BIND(?c AS ?t) } ORDER BY ?t ?i`).rows;
    const by = {}; for (const r of rows) { const l = r.l ? r.l.value : short(r.i.value); if (f && !l.toLowerCase().includes(f) && !short(r.t.value).toLowerCase().includes(f)) continue; (by[r.t.value] ||= new Map()).set(r.i.value, l); }
    $("tree").innerHTML = "<ul>" + Object.keys(by).sort().map((t) => `<li><span data-iri="${esc(t)}"><b>${esc(label(t))}</b></span><ul>${[...by[t]].map(([i, l]) => `<li><span data-iri="${esc(i)}">${esc(l)}</span></li>`).join("")}</ul></li>`).join("") + "</ul>";
  }
}

// ---------- right detail ----------
const termHTML = (t) => !t ? "" : (t.termType === "NamedNode" || (t.termType !== "Literal" && /^https?:/.test(t.value))) ? `<a class="iri" data-iri="${esc(t.value)}" title="${esc(t.value)}">${esc(short(t.value))}</a>`
  : t.termType === "BlankNode" ? `<span class="muted">[ ]</span>` : esc(t.value);
function showDetail(iri) {
  document.querySelectorAll("#tree span.sel").forEach((e) => e.classList.remove("sel"));
  document.querySelectorAll(`#tree span[data-iri="${CSS.escape(iri)}"]`).forEach((e) => e.classList.add("sel"));
  const out = select(`SELECT ?p ?o WHERE { <${iri}> ?p ?o } ORDER BY ?p`).rows;
  const inc = select(`SELECT ?s ?p WHERE { ?s ?p <${iri}> } ORDER BY ?p LIMIT 200`).rows;
  const isClass = select(`ASK { <${iri}> a owl:Class }`).ask;
  let h = `<h2>${esc(label(iri))}</h2><div class="muted">${esc(short(iri))}</div>`;
  h += `<p><button id="d-graph">Show in graph</button></p>`;
  const ann = out.filter((r) => [PFX.rdfs + "comment", PFX.pcaq + "openQuestion", PFX.pcaq + "sourceSheet", PFX.pcaq + "sourceColumn", PFX.pcaq + "populationMode"].includes(r.p.value));
  if (ann.length) h += `<table class="kv">${ann.map((r) => `<tr><td>${esc(short(r.p.value).replace(/^\w+:/, ""))}</td><td class="${r.p.value.endsWith("openQuestion") ? "q" : ""}">${esc(r.o.value)}</td></tr>`).join("")}</table>`;
  if (isClass) {
    const inst = select(`SELECT DISTINCT ?i WHERE { ?s rdfs:subClassOf* <${iri}> . ?i a ?s } ORDER BY ?i LIMIT 300`).rows;
    const props = select(`SELECT ?p ?k ?r WHERE { ?p rdfs:domain <${iri}> ; a ?k . FILTER(?k IN (owl:ObjectProperty, owl:DatatypeProperty)) OPTIONAL { ?p rdfs:range ?r } } ORDER BY ?p`).rows;
    if (props.length) h += `<h3>Properties (domain)</h3><table>${props.map((r) => `<tr><td>${termHTML(r.p)}</td><td>${r.r ? termHTML(r.r) : ""}</td></tr>`).join("")}</table>`;
    h += `<h3>Instances (${inst.length})</h3>${inst.map((r) => termHTML(r.i)).join("<br>") || '<span class="muted">none</span>'}`;
  }
  const rest = out.filter((r) => !ann.includes(r));
  h += `<h3>Statements</h3><table class="kv">${rest.map((r) => `<tr><td>${esc(short(r.p.value))}</td><td>${termHTML(r.o)}</td></tr>`).join("")}</table>`;
  if (inc.length) h += `<h3>Referenced by</h3><table class="kv">${inc.map((r) => `<tr><td>${esc(short(r.p.value))}</td><td>${termHTML(r.s)}</td></tr>`).join("")}</table>`;
  $("detail").innerHTML = h; $("detail").classList.remove("muted");
  $("d-graph").onclick = () => { tab("graph"); addNode(iri); expand(iri); };
}

// ---------- graph (single style source → network + legend) ----------
const GRAPH_STYLE = {
  nodeDefaults: { shape: "box", font: { color: "#0b0f14", size: 11 }, margin: 6, borderWidth: 0 },
  edgeDefaults: { arrows: "to", font: { size: 9, color: "#8593a3", strokeWidth: 0 }, color: "#3a4553", smooth: { type: "dynamic" } },
  // groups: color + shape drive both vis nodes and the left-pane legend
  groups: {
    class:      { color: "#6e7fd6", shape: "ellipse", legend: "OWL class" },
    QuotedPart:   { color: "#4da3ff", shape: "box",     legend: "Quoted part" },
    CostElement:{ color: "#3fb27f", shape: "box",     legend: "Cost element / breakdown" },
    SellingPrice:{ color: "#f08b5a", shape: "box",    legend: "Selling price" },
    LTA:        { color: "#e0a63a", shape: "box",     legend: "LTA schedule / step" },
    estimate:   { color: "#d46ee8", shape: "box",     legend: "Imported estimate (prov)" },
    Interco:    { color: "#2ec4b6", shape: "box",     legend: "Interco transfer / plant" },
    Margin:     { color: "#ff6b9d", shape: "box",     legend: "Margin view" },
    other:      { color: "#8593a3", shape: "box",     legend: "Other individual" },
    lit:        { color: "#2a3340", shape: "text",    legend: "Literal value", fontColor: "#c8d2de" },
    leafOpen:   { color: "#e85d5d", shape: "diamond", legend: "Leaf Tender · open" },
    leafProgress:{ color: "#e0a63a", shape: "diamond", legend: "Leaf Tender · in progress" },
    leafResolved:{ color: "#3fb27f", shape: "diamond", legend: "Leaf Tender · resolved" },
  },
  edges: {
    property:  { color: "#3a4553", dashes: false, legend: "Property edge" },
    subclass:  { color: "#3a4553", dashes: true,  legend: "subClassOf" },
  },
};
const COLORS = Object.fromEntries(Object.entries(GRAPH_STYLE.groups).map(([k, v]) => [k, v.color]));
function groupOf(iri) {
  if (select(`ASK { <${iri}> a owl:Class }`).ask) return "class";
  const t = (c) => select(`ASK { <${iri}> a/rdfs:subClassOf* ${c} }`).ask;
  if (t("pcaq:QuotedPart")) return "QuotedPart"; if (t("pcaq:CostElement") || t("pcaq:CostBreakdown")) return "CostElement";
  if (t("pcaq:SellingPrice")) return "SellingPrice"; if (t("pcaq:LTASchedule") || t("pcaq:LTAStep")) return "LTA";
  if (t("pcaq:IntercompanyTransfer") || t("pcaq:IntercompanySubcomponent") || t("pcaq:UnresolvedPlant")) return "Interco";
  if (t("pcaq:MarginView") || t("pcaq:FinishedGoodsMargin") || t("pcaq:IntercompanyMargin") || t("pcaq:TotalCompanyMargin")) return "Margin";
  if (t("prov:Entity")) return "estimate"; return "other";
}
function renderLegend() {
  const el = $("graph-legend"); if (!el) return;
  const rows = Object.values(GRAPH_STYLE.groups).map((g) => {
    if (g.shape === "text") return `<div class="legend-row"><span class="legend-swatch shape-text" style="color:${g.fontColor || "#c8d2de"}">Aa</span><span>${esc(g.legend)}</span></div>`;
    const shapeCls = g.shape === "ellipse" ? " shape-ellipse" : "";
    return `<div class="legend-row"><span class="legend-swatch${shapeCls}" style="background:${g.color}"></span><span>${esc(g.legend)}</span></div>`;
  }).join("");
  const edges = Object.values(GRAPH_STYLE.edges).map((e) =>
    `<div class="legend-row"><span class="legend-edge${e.dashes ? " dashed" : ""}" style="border-top-color:${e.color}"></span><span>${esc(e.legend)}</span></div>`).join("");
  el.innerHTML = `<h3>Graph key</h3><div class="legend-section">${rows}</div><div class="legend-section">${edges}</div>`;
}
function ensureNet() {
  if (net) return;
  nodes = new vis.DataSet(); edges = new vis.DataSet();
  net = new vis.Network($("graph"), { nodes, edges }, {
    nodes: { ...GRAPH_STYLE.nodeDefaults },
    edges: { ...GRAPH_STYLE.edgeDefaults },
    physics: { solver: "forceAtlas2Based", forceAtlas2Based: { gravitationalConstant: -70, springLength: 110 }, stabilization: { iterations: 100 } },
    interaction: { hover: true } });
  net.on("stabilizationIterationsDone", () => net.fit());
  net.on("click", (p) => {
    const id = p.nodes[0]; if (!id || id.startsWith("lit:")) return;
    if (String(id).startsWith("leaf:")) {
      const lid = String(id).slice(5);
      $("detail").innerHTML = `<h2>Leaf Tender</h2><div class="muted">${esc(lid)}</div>
        <p><a class="iri" href="https://leaftender.chriscouch.net/#leaf=${encodeURIComponent(lid)}">Open in Leaf Tender</a></p>`;
      $("detail").classList.remove("muted");
      return;
    }
    showDetail(id);
  });
  net.on("doubleClick", (p) => { const id = p.nodes[0]; if (id && !id.startsWith("lit:")) expand(id); });
}
function addNode(iri) {
  ensureNet(); if (nodes.get(iri)) return;
  const g = groupOf(iri); const st = GRAPH_STYLE.groups[g] || GRAPH_STYLE.groups.other;
  nodes.add({ id: iri, label: label(iri), title: short(iri), color: { background: st.color }, shape: st.shape });
  if (usageOn) paintUsage([iri]);
}
function addEdge(s, p, o, kind = "property") {
  const id = s + "|" + p + "|" + o; if (edges.get(id)) return;
  const st = GRAPH_STYLE.edges[kind] || GRAPH_STYLE.edges.property;
  edges.add({ id, from: s, to: o, label: short(p).replace(/^\w+:/, ""), color: st.color, dashes: st.dashes });
}
function expand(iri) {
  addNode(iri);
  for (const r of select(`SELECT ?p ?o WHERE { <${iri}> ?p ?o FILTER(?p NOT IN (rdfs:label, rdfs:comment, pcaq:sourceColumn, pcaq:sourceSheet, pcaq:openQuestion, pcaq:populationMode, owl:equivalentClass)) } LIMIT 80`).rows) {
    if (r.o.termType === "NamedNode") { if (r.o.value === PFX.owl + "Class") continue; addNode(r.o.value); addEdge(iri, r.p.value, r.o.value); }
    else if (r.o.termType === "Literal") { const id = "lit:" + iri + r.p.value + r.o.value; const lit = GRAPH_STYLE.groups.lit; if (!nodes.get(id)) nodes.add({ id, label: r.o.value.slice(0, 30), shape: lit.shape, font: { color: lit.fontColor || "#c8d2de", size: 10 }, color: { background: lit.color } }); addEdge(iri, r.p.value, id); }
  }
  for (const r of select(`SELECT ?s ?p WHERE { ?s ?p <${iri}> FILTER(?p != rdf:type || !EXISTS { <${iri}> a owl:Class }) } LIMIT 40`).rows)
    if (r.s.termType === "NamedNode") { addNode(r.s.value); addEdge(r.s.value, r.p.value, iri); }
}
function schemaGraph() {
  ensureNet(); nodes.clear(); edges.clear();
  for (const r of select(`SELECT ?c ?p WHERE { ?c a owl:Class FILTER isIRI(?c) OPTIONAL { ?c rdfs:subClassOf ?p FILTER(isIRI(?p) && STRSTARTS(STR(?p), "${PFX.pcaq}")) } }`).rows) {
    addNode(r.c.value); if (r.p) { addNode(r.p.value); const st = GRAPH_STYLE.edges.subclass; edges.update({ id: r.c.value + "|sub|" + r.p.value, from: r.c.value, to: r.p.value, dashes: st.dashes, color: st.color, label: "subClassOf" }); } }
  for (const r of select(`SELECT ?p ?d ?r WHERE { ?p a owl:ObjectProperty ; rdfs:domain ?d ; rdfs:range ?r FILTER(STRSTARTS(STR(?r), "${PFX.pcaq}")) }`).rows) { addNode(r.d.value); addNode(r.r.value); addEdge(r.d.value, r.p.value, r.r.value); }
  net.fit();
}
function quoteDetailGraph() {
  ensureNet(); nodes.clear(); edges.clear();
  // Prefer a line that has an IC transfer tree so the supply-chain edges show up
  const line = select(`SELECT ?l WHERE { ?l a pcaq:QuotedPart ; pcaq:hasIntercompanyTransfer ?t } ORDER BY ?l LIMIT 1`).rows[0]?.l.value
    || select(`SELECT ?l WHERE { ?l a pcaq:QuotedPart ; pcaq:hasEstimate ?e } ORDER BY ?l LIMIT 1`).rows[0]?.l.value;
  if (!line) return;
  expand(line);
  for (const p of ["hasCostBreakdown", "hasLTASchedule", "hasEstimate", "inWorkbook", "hasFinishedGoodsMargin", "hasIntercompanyMargin", "hasTotalCompanyMargin"]) {
    for (const o of select(`SELECT ?o WHERE { <${line}> pcaq:${p} ?o }`).rows) expand(o.o.value);
  }
  for (const r of select(`SELECT ?y WHERE { <${line}> pcaq:hasYearPrice ?y }`).rows) expand(r.y.value);
  // IC supply chain: roots + nested children via ^parentTransfer*
  for (const r of select(`SELECT ?t WHERE { <${line}> pcaq:hasIntercompanyTransfer/^pcaq:parentTransfer* ?t }`).rows) {
    expand(r.t.value);
    for (const p of ["producingPlant", "receivingPlant", "ofSubcomponent", "parentTransfer"]) {
      for (const o of select(`SELECT ?o WHERE { <${r.t.value}> pcaq:${p} ?o }`).rows) expand(o.o.value);
    }
  }
  net.fit();
}

// ---------- SPARQL ----------
function runQuery() {
  const t0 = performance.now(); $("q-out").innerHTML = "";
  try {
    const r = store.query($("q-text").value); const ms = Math.round(performance.now() - t0);
    if (typeof r === "boolean") { $("q-out").innerHTML = `<p>ASK → <b class="${r ? "ok" : "bad"}">${r}</b></p>`; lastResult = null; }
    else if (r.length && r[0] instanceof Map || Array.isArray(r) && !r.length) {
      const vars = r.length ? [...r[0].keys()] : []; lastResult = { vars, rows: r.map((m) => vars.map((v) => m.get(v))) };
      $("q-out").innerHTML = `<table><tr>${vars.map((v) => `<th>?${esc(v)}</th>`).join("")}</tr>${lastResult.rows.map((row) => `<tr>${row.map((t) => `<td>${termHTML(t)}</td>`).join("")}</tr>`).join("")}</table>`;
    } else { // CONSTRUCT / DESCRIBE
      lastResult = null; $("q-out").innerHTML = `<pre>${esc(r.map((q) => `${short(q.subject.value)} ${short(q.predicate.value)} ${q.object.termType === "Literal" ? JSON.stringify(q.object.value) : short(q.object.value)} .`).join("\n"))}</pre>`;
    }
    $("q-ms").textContent = `${r.length ?? ""} ${typeof r === "boolean" ? "" : "rows"} · ${ms} ms`;
  } catch (e) { $("q-out").innerHTML = `<div class="err">${esc(e.message || e)}</div>`; $("q-ms").textContent = ""; }
}
function csv() {
  if (!lastResult) return; const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const body = [lastResult.vars.map(q).join(","), ...lastResult.rows.map((r) => r.map((t) => q(t?.value)).join(","))].join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([body], { type: "text/csv" })); a.download = "pcaq-query.csv"; a.click();
}

// ---------- SHACL ----------
async function validate() {
  const t0 = performance.now(); const ds = rdf.dataset(); const parse = (t) => new Parser().parse(t);
  for (const t of [...FILES.map((f) => texts[f]), ...extra.map((e) => e.text)]) for (const q of parse(t)) ds.add(q);
  const v = new Validator(rdf.dataset(parse(texts[SHAPES])), { factory: rdf });
  const rep = await v.validate({ dataset: ds });
  $("v-ms").textContent = `${ds.size} triples · ${Math.round(performance.now() - t0)} ms`;
  $("v-out").innerHTML = `<p class="${rep.conforms ? "ok" : "bad"}"><b>${rep.conforms ? "Conforms" : rep.results.length + " violation(s)"}</b></p>` +
    (rep.results.length ? `<table><tr><th>focus node</th><th>message</th></tr>${rep.results.map((r) => `<tr><td>${termHTML(r.focusNode)}</td><td>${esc(r.message?.[0]?.value || "(no message)")}</td></tr>`).join("")}</table>` : "") +
    `<p class="muted">Line P-005 is incomplete on purpose so the shapes have something to report.</p>`;
}

// ---------- right pane collapse (localStorage) ----------
const RIGHT_KEY = "pcaq-viewer-right-collapsed";
function setRightCollapsed(collapsed) {
  document.querySelector("main").classList.toggle("right-collapsed", collapsed);
  const btn = $("right-toggle");
  btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  btn.title = collapsed ? "Expand detail pane" : "Collapse detail pane";
  btn.setAttribute("aria-label", btn.title);
  btn.textContent = collapsed ? "⟨" : "⟩";
  try { localStorage.setItem(RIGHT_KEY, collapsed ? "1" : "0"); } catch (_) {}
  if (net) { requestAnimationFrame(() => { net.redraw(); try { net.fit(); } catch (_) {} }); }
}
function initRightPane() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(RIGHT_KEY) === "1"; } catch (_) {}
  setRightCollapsed(collapsed);
  $("right-toggle").onclick = () => setRightCollapsed(!document.querySelector("main").classList.contains("right-collapsed"));
  $("right-toggle").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("right-toggle").click(); } };
}

// ---------- wiring ----------
function tab(name) { document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name)); document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== "tab-" + name)); if (name === "graph" && net) net.redraw(); }
document.addEventListener("click", (e) => { const el = e.target.closest("[data-iri]"); if (el) showDetail(el.dataset.iri); });
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => tab(b.dataset.tab)));
$("mode-class").onclick = () => { treeMode = "class"; $("mode-class").classList.add("on"); $("mode-inst").classList.remove("on"); renderTree(); };
$("mode-inst").onclick = () => { treeMode = "inst"; $("mode-inst").classList.add("on"); $("mode-class").classList.remove("on"); renderTree(); };
$("filter").oninput = renderTree;
$("g-schema").onclick = schemaGraph; $("g-quote-detail").onclick = quoteDetailGraph; $("g-clear").onclick = () => { ensureNet(); nodes.clear(); edges.clear(); };
$("q-run").onclick = runQuery; $("q-csv").onclick = csv;
$("q-text").onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runQuery(); } };
$("q-pick").onchange = () => { $("q-text").value = queries[+$("q-pick").value].text; runQuery(); };
$("v-run").onclick = () => validate().catch((e) => ($("v-out").innerHTML = `<div class="err">${esc(e.message)}</div>`));
$("reset").onclick = () => { extra = []; buildStore(); };
$("file").onchange = async (e) => { for (const f of e.target.files) extra.push({ name: f.name, text: await f.text() });
  try { buildStore(); } catch (err) { alert("Could not load: " + err.message); extra = []; buildStore(); } e.target.value = ""; };

(async () => {
  try {
    await initOx();
    for (const f of [...FILES, SHAPES]) texts[f] = await fetchText(f);
    const names = (await fetchText("queries/index.txt")).split("\n").filter(Boolean);
    queries = await Promise.all(names.map(async (n) => { const t = await fetchText("queries/" + n); return { n, text: t, title: t.split("\n")[0].replace(/^#\s*/, "") }; }));
    $("q-pick").innerHTML = queries.map((q, i) => `<option value="${i}">${esc(q.title)}</option>`).join("");
    $("q-text").value = queries[0]?.text || "";
    buildStore(); renderLegend(); initRightPane(); quoteDetailGraph(); initUsageToggle();
    await applyLeafDeepLink();
  } catch (e) { $("stats").innerHTML = `<span class="err">Load failed: ${esc(e.message)}. Serve this folder over http (./serve.sh), not file://</span>`; }
})();

// ---------- Leaf Tender deep-link + status overlay ----------
function leafGroup(status) {
  if (status === "resolved") return "leafResolved";
  if (status === "in_progress" || status === "blocked") return "leafProgress";
  return "leafOpen";
}
function addLeafOverlayNode(leaf) {
  ensureNet();
  const id = "leaf:" + leaf.id;
  if (nodes.get(id)) nodes.remove(id);
  const g = leafGroup(leaf.status);
  const st = GRAPH_STYLE.groups[g];
  nodes.add({
    id, label: "Leaf: " + (leaf.title || leaf.id).slice(0, 48),
    title: `Leaf Tender: ${leaf.title} (${leaf.status})`,
    color: { background: st.color, border: "#fff" }, shape: st.shape, borderWidth: 2,
    font: { color: "#0b0f14", size: 10 },
  });
  if (leaf.graph_iri) {
    addNode(leaf.graph_iri);
    const eid = id + "|focus|" + leaf.graph_iri;
    if (!edges.get(eid)) edges.add({ id: eid, from: id, to: leaf.graph_iri, label: "focus", color: st.color, dashes: true });
  }
  if (leaf.parent_leaf_id) {
    const pid = "leaf:" + leaf.parent_leaf_id;
    if (nodes.get(pid)) {
      const eid = pid + "|spawn|" + id;
      if (!edges.get(eid)) edges.add({ id: eid, from: pid, to: id, label: "spawned", color: "#8593a3", dashes: true });
    }
  }
  return id;
}
async function applyLeafDeepLink() {
  const sp = new URLSearchParams(location.search);
  const leafId = sp.get("leaf");
  const focus = sp.get("focus");
  // Optional overlay from Leaf Tender (same origin behind gate). Ignore auth failures.
  // Only hit Leaf Tender when a deep-link is present (avoids console 404 noise on standalone viewer / e2e).
  let overlay = [];
  if (leafId) {
    try {
      const r = await fetch("https://leaftender.chriscouch.net/api/leaves/overlay", { credentials: "same-origin" });
      if (r.ok) overlay = (await r.json()).leaves || [];
    } catch (_) {}
  }
  if (overlay.length) {
    const pick = overlay.filter((l) => l.id === leafId || l.parent_leaf_id === leafId);
    for (const l of pick) addLeafOverlayNode(l);
  } else if (leafId) {
    addLeafOverlayNode({ id: leafId, title: leafId, status: "open", graph_iri: focus && focus.startsWith("http") ? focus : null });
  }
  if (focus && !focus.startsWith("leaf:")) {
    try {
      if (select(`ASK { <${focus}> ?p ?o }`).ask || select(`ASK { ?s ?p <${focus}> }`).ask) {
        tab("graph"); addNode(focus); expand(focus);
        if (net) { net.selectNodes([focus]); net.focus(focus, { scale: 1.2, animation: true }); }
        showDetail(focus);
      }
    } catch (_) {}
  }
  if (leafId && net) {
    const nid = "leaf:" + leafId;
    if (nodes.get(nid)) { net.selectNodes([nid]); try { net.focus(nid, { scale: 1.1, animation: true }); } catch (_) {} }
  }
}


// ---------- usage overlay toggle (ops data from Leaf Tender; default OFF) ----------
const USAGE_KEY = "pcaq-viewer-show-usage";
let usageOn = false, usageByIri = null, usageLoading = null;
const RISK_BORDER = (r) => (r >= 0.5 ? "#e5534b" : r > 0 ? "#e0a63a" : null);
async function loadUsage() {
  if (usageByIri) return usageByIri;
  if (!usageLoading) usageLoading = (async () => {
    const m = new Map();
    try {
      const r = await fetch("https://leaftender.chriscouch.net/api/leaves/overlay", { credentials: "same-origin" });
      if (r.ok) for (const l of (await r.json()).leaves || []) {
        if (!l.graph_iri) continue;
        const u = m.get(l.graph_iri) || { use_count: 0, last_used_at: null, risk_score: 0, leaves: 0 };
        u.use_count += l.use_count || 0; u.leaves++;
        if (l.last_used_at && (!u.last_used_at || l.last_used_at > u.last_used_at)) u.last_used_at = l.last_used_at;
        u.risk_score = Math.max(u.risk_score, l.risk_score || 0);
        m.set(l.graph_iri, u);
      }
    } catch (_) {}
    usageByIri = m; return m;
  })();
  return usageLoading;
}
function baseNode(id) {
  const g = groupOf(id); const st = GRAPH_STYLE.groups[g] || GRAPH_STYLE.groups.other;
  return { id, label: label(id), title: short(id), color: { background: st.color }, borderWidth: 0 };
}
function paintUsage(ids) {
  if (!nodes || !usageByIri) return;
  const upd = [];
  for (const id of ids || nodes.getIds()) {
    if (typeof id !== "string" || id.startsWith("lit:") || id.startsWith("leaf:")) continue;
    const b = baseNode(id);
    if (usageOn) {
      const u = usageByIri.get(id);
      if (u) {
        const border = RISK_BORDER(u.risk_score);
        b.label += `\n▲ ${u.use_count} use${u.use_count === 1 ? "" : "s"}`;
        b.title = `${short(id)}\nUses: ${u.use_count}\nLast used: ${u.last_used_at || "never"}\nRisk: ${u.risk_score}`;
        if (border) { b.color = { background: b.color.background, border }; b.borderWidth = 3; }
      }
    }
    upd.push(b);
  }
  if (upd.length) nodes.update(upd);
}
async function setUsage(on) {
  usageOn = on;
  const btn = $("g-usage"); btn.setAttribute("aria-pressed", on ? "true" : "false"); btn.textContent = on ? "Hide usage" : "Show usage";
  try { localStorage.setItem(USAGE_KEY, on ? "1" : "0"); } catch (_) {}
  const note = $("usage-note");
  if (on) {
    const m = await loadUsage();
    note.hidden = false;
    note.textContent = m.size ? `usage overlay: ${m.size} node(s) with Leaf Tender use counts · red/amber border = risk` : "usage overlay: no usage data (sign in to Leaf Tender)";
  } else note.hidden = true;
  paintUsage();
}
function initUsageToggle() {
  let on = false; try { on = localStorage.getItem(USAGE_KEY) === "1"; } catch (_) {}
  $("g-usage").onclick = () => setUsage(!usageOn);
  if (on) setUsage(true);
}
