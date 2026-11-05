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

// ---------- graph ----------
const COLORS = { class: "#6e7fd6", PartLine: "#4da3ff", CostElement: "#3fb27f", SellingPrice: "#f08b5a", LTA: "#e0a63a", estimate: "#d46ee8", Interco: "#2ec4b6", Margin: "#ff6b9d", other: "#8593a3", lit: "#2a3340" };
function groupOf(iri) {
  if (select(`ASK { <${iri}> a owl:Class }`).ask) return "class";
  const t = (c) => select(`ASK { <${iri}> a/rdfs:subClassOf* ${c} }`).ask;
  if (t("pcaq:PartLine")) return "PartLine"; if (t("pcaq:CostElement") || t("pcaq:CostBreakdown")) return "CostElement";
  if (t("pcaq:SellingPrice")) return "SellingPrice"; if (t("pcaq:LTASchedule") || t("pcaq:LTAStep")) return "LTA";
  if (t("pcaq:IntercompanyTransfer") || t("pcaq:IntercompanySubcomponent") || t("pcaq:UnresolvedPlant")) return "Interco";
  if (t("pcaq:MarginView") || t("pcaq:FinishedGoodsMargin") || t("pcaq:IntercompanyMargin") || t("pcaq:TotalCompanyMargin")) return "Margin";
  if (t("prov:Entity")) return "estimate"; return "other";
}
function ensureNet() {
  if (net) return;
  nodes = new vis.DataSet(); edges = new vis.DataSet();
  net = new vis.Network($("graph"), { nodes, edges }, {
    nodes: { shape: "box", font: { color: "#0b0f14", size: 11 }, margin: 6, borderWidth: 0 },
    edges: { arrows: "to", font: { size: 9, color: "#8593a3", strokeWidth: 0 }, color: "#3a4553", smooth: { type: "dynamic" } },
    physics: { solver: "forceAtlas2Based", forceAtlas2Based: { gravitationalConstant: -70, springLength: 110 }, stabilization: { iterations: 100 } },
    interaction: { hover: true } });
  net.on("stabilizationIterationsDone", () => net.fit());
  net.on("click", (p) => { const id = p.nodes[0]; if (id && !id.startsWith("lit:")) showDetail(id); });
  net.on("doubleClick", (p) => { const id = p.nodes[0]; if (id && !id.startsWith("lit:")) expand(id); });
}
function addNode(iri) { ensureNet(); if (!nodes.get(iri)) { const g = groupOf(iri); nodes.add({ id: iri, label: label(iri), title: short(iri), color: { background: COLORS[g] }, ...(g === "class" ? { shape: "ellipse" } : {}) }); } }
function addEdge(s, p, o) { const id = s + "|" + p + "|" + o; if (!edges.get(id)) edges.add({ id, from: s, to: o, label: short(p).replace(/^\w+:/, "") }); }
function expand(iri) {
  addNode(iri);
  for (const r of select(`SELECT ?p ?o WHERE { <${iri}> ?p ?o FILTER(?p NOT IN (rdfs:label, rdfs:comment, pcaq:sourceColumn, pcaq:sourceSheet, pcaq:openQuestion, pcaq:populationMode, owl:equivalentClass)) } LIMIT 80`).rows) {
    if (r.o.termType === "NamedNode") { if (r.o.value === PFX.owl + "Class") continue; addNode(r.o.value); addEdge(iri, r.p.value, r.o.value); }
    else if (r.o.termType === "Literal") { const id = "lit:" + iri + r.p.value + r.o.value; if (!nodes.get(id)) nodes.add({ id, label: r.o.value.slice(0, 30), shape: "text", font: { color: "#c8d2de", size: 10 } }); addEdge(iri, r.p.value, id); }
  }
  for (const r of select(`SELECT ?s ?p WHERE { ?s ?p <${iri}> FILTER(?p != rdf:type || !EXISTS { <${iri}> a owl:Class }) } LIMIT 40`).rows)
    if (r.s.termType === "NamedNode") { addNode(r.s.value); addEdge(r.s.value, r.p.value, iri); }
}
function schemaGraph() {
  ensureNet(); nodes.clear(); edges.clear();
  for (const r of select(`SELECT ?c ?p WHERE { ?c a owl:Class FILTER isIRI(?c) OPTIONAL { ?c rdfs:subClassOf ?p FILTER(isIRI(?p) && STRSTARTS(STR(?p), "${PFX.pcaq}")) } }`).rows) {
    addNode(r.c.value); if (r.p) { addNode(r.p.value); edges.update({ id: r.c.value + "|sub|" + r.p.value, from: r.c.value, to: r.p.value, dashes: true, label: "subClassOf" }); } }
  for (const r of select(`SELECT ?p ?d ?r WHERE { ?p a owl:ObjectProperty ; rdfs:domain ?d ; rdfs:range ?r FILTER(STRSTARTS(STR(?r), "${PFX.pcaq}")) }`).rows) { addNode(r.d.value); addNode(r.r.value); addEdge(r.d.value, r.p.value, r.r.value); }
  net.fit();
}
function spineGraph() {
  ensureNet(); nodes.clear(); edges.clear();
  // Prefer a line that has an IC transfer tree so the supply-chain edges show up
  const line = select(`SELECT ?l WHERE { ?l a pcaq:PartLine ; pcaq:hasIntercompanyTransfer ?t } ORDER BY ?l LIMIT 1`).rows[0]?.l.value
    || select(`SELECT ?l WHERE { ?l a pcaq:PartLine ; pcaq:hasEstimate ?e } ORDER BY ?l LIMIT 1`).rows[0]?.l.value;
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

// ---------- wiring ----------
function tab(name) { document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name)); document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== "tab-" + name)); if (name === "graph" && net) net.redraw(); }
document.addEventListener("click", (e) => { const el = e.target.closest("[data-iri]"); if (el) showDetail(el.dataset.iri); });
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => tab(b.dataset.tab)));
$("mode-class").onclick = () => { treeMode = "class"; $("mode-class").classList.add("on"); $("mode-inst").classList.remove("on"); renderTree(); };
$("mode-inst").onclick = () => { treeMode = "inst"; $("mode-inst").classList.add("on"); $("mode-class").classList.remove("on"); renderTree(); };
$("filter").oninput = renderTree;
$("g-schema").onclick = schemaGraph; $("g-spine").onclick = spineGraph; $("g-clear").onclick = () => { ensureNet(); nodes.clear(); edges.clear(); };
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
    buildStore(); spineGraph();
  } catch (e) { $("stats").innerHTML = `<span class="err">Load failed: ${esc(e.message)}. Serve this folder over http (./serve.sh), not file://</span>`; }
})();
