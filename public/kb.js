// In-browser knowledge base: the real rfq-ontology files (copied into data/), validated with shacl-engine (N3.js parser)
// and queried with Oxigraph (SPARQL 1.1, WebAssembly). Everything here runs in the visitor's browser.
import { Parser, rdf, Validator } from "./vendor/rdf-shacl.js";
import initOx, * as ox from "./vendor/oxigraph/web.js";

export const ONTOLOGY = ["rfq.ttl", "rfq-core.ttl", "rfq-provenance.ttl", "rfq-package.ttl", "rfq-bom.ttl", "rfq-library.ttl", "rfq-costing.ttl", "rfq-pla.ttl"].map((f) => "ontology/" + f);
export const DATA = ["reference.ttl", "rfq-1001.ttl", "rfq-1002-incomplete.ttl", "pla-run-1002.ttl", "quote-results.ttl"];
export const QUERIES = Array.from({ length: 12 }, (_, i) => i + 1);
const QFILES = { 1: "cq1-rfq-completeness", 2: "cq2-make-vs-buy", 3: "cq3-similarity-used", 4: "cq4-cogs-by-break", 5: "cq5-conversion-drivers",
  6: "cq6-stale-rates", 7: "cq7-manual-review", 8: "cq8-freight-by-incoterm", 9: "cq9-open-issues", 10: "cq10-tool-runs-by-kind",
  11: "cq11-unapproved-quotes", 12: "cq12-rfq-line-matches" };
const NS = { rfq: "https://supergus.github.io/rfq-ontology/ns#", ex: "https://supergus.github.io/rfq-ontology/data#" };
const SH_PREFIX = "http://www.w3.org/ns/shacl#";

const text = async (p) => { const r = await fetch("data/" + p); if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`); return r.text(); };
const parse = (ttl) => new Parser().parse(ttl);

export const kb = { ready: false, error: null, files: {}, queries: {}, fix: "", store: null, validator: null };

export async function loadKB() {
  const files = [...ONTOLOGY, ...DATA, "rfq-completeness.ttl"];
  const texts = await Promise.all(files.map(text));
  files.forEach((f, i) => (kb.files[f] = texts[i]));
  const qs = await Promise.all(QUERIES.map((n) => text(`queries/${QFILES[n]}.rq`)));
  QUERIES.forEach((n, i) => (kb.queries[n] = { file: QFILES[n] + ".rq", text: qs[i], title: qs[i].split("\n")[0].replace(/^#\s*/, "") }));
  kb.validator = new Validator(rdf.dataset(parse(kb.files["rfq-completeness.ttl"])), { factory: rdf });
  await initOx();
  resetStore();
  kb.ready = true;
  return kb;
}

/** The human fix as Turtle (Incoterm chosen in the issues panel + the A36 material spec). */
export function fixTurtle(incoterm, spec) {
  let t = `@prefix rfq: <${NS.rfq}> .\n@prefix ex: <${NS.ex}> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n`;
  if (incoterm) t += `ex:RFQ-1002-DT rfq:hasIncoterm rfq:${incoterm} .\n`;
  if (spec) t += `ex:RFQ-1002 rfq:hasTechnicalRequirement ex:SPEC-1002-A36 .\nex:SPEC-1002-A36 a rfq:MaterialSpec ; rdfs:label "ASTM A36 steel plate" .\n`;
  return t;
}

/** Fresh SPARQL store with the repo's ontology + data only (used at load and for each new run). */
export function resetStore() {
  kb.store = new ox.Store(); kb.fix = "";
  for (const f of [...ONTOLOGY, ...DATA]) kb.store.load(kb.files[f], { format: "text/turtle", base_iri: "https://supergus.github.io/rfq-ontology/" });
  kb.baseSize = kb.store.size;
}

/** Apply fix triples to the SPARQL store (idempotent: Oxigraph stores a set of quads). */
export function applyFix(ttl) { kb.fix = ttl; kb.store.load(ttl, { format: "text/turtle" }); }

/** Live SHACL: ontology + reference data + RFQ-1002 (+ fix) against shapes/rfq-completeness.ttl. */
export async function validateRFQ(fix) {
  const t0 = performance.now();
  const ds = rdf.dataset();
  for (const f of [...ONTOLOGY, "reference.ttl", "rfq-1002-incomplete.ttl"]) for (const q of parse(kb.files[f])) ds.add(q);
  if (fix) for (const q of parse(fix)) ds.add(q);
  const report = await kb.validator.validate({ dataset: ds });
  const shapeOf = (r) => { // sh:sourceShape from the report dataset
    for (const q of report.dataset.match(null, rdf.namedNode(SH_PREFIX + "resultMessage"))) {
      if (q.object.value === r.message?.[0]?.value) { const s = [...report.dataset.match(q.subject, rdf.namedNode(SH_PREFIX + "sourceShape"))][0]; if (s) return s.object.value.split("#").pop(); }
    }
    return "?";
  };
  const results = report.results.map((r) => ({ focus: r.focusNode.value.split("#").pop(), message: r.message?.[0]?.value || "(no message)", shape: shapeOf(r) }))
    .sort((a, b) => a.message.localeCompare(b.message));
  return { conforms: report.conforms, results, ms: Math.round(performance.now() - t0), triples: ds.size };
}

const short = (t) => t == null ? null : t.termType === "Literal" ? t.value : t.value.replace(NS.ex, "ex:").replace(NS.rfq, "rfq:");
/** Run a SPARQL SELECT/ASK against the live store. */
export function sparql(q) {
  const t0 = performance.now();
  const r = kb.store.query(q);
  const ms = Math.round(performance.now() - t0);
  if (typeof r === "boolean") return { ask: r, ms };
  const vars = r.length ? [...r[0].keys()] : (q.match(/SELECT\s+(?:DISTINCT\s+)?([^{]*?)\s*WHERE/i)?.[1].match(/\?\w+/g) || []).map((v) => v.slice(1));
  return { vars, rows: r.map((m) => vars.map((v) => short(m.get(v)))), ms };
}

/** The defined class rfq:CompleteRFQ (owl:equivalentClass in ontology/rfq-package.ttl) written as one SPARQL ASK.
 *  It checks the same existential restrictions HermiT uses, on the asserted data only (no other OWL inference). */
export const COMPLETE_RFQ_ASK = `PREFIX rfq: <${NS.rfq}>
PREFIX ex:  <${NS.ex}>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
ASK {
  ex:RFQ-1002 a rfq:RFQPackage ;
      rfq:hasCommercialTerms [ a rfq:CommercialTerms ] ;
      rfq:hasDeliveryTerms ?dt ;
      rfq:hasLine [ rfq:hasQuantityBreak [ a rfq:QuantityBreak ] ] .
  ?dt a rfq:DeliveryTerms ; rfq:hasIncoterm [ a rfq:Incoterm ] ; rfq:requestedDeliveryDate ?d .
  FILTER(datatype(?d) = xsd:dateTime)
  ex:RFQ-1002 rfq:hasTechnicalRequirement [ a rfq:Drawing ] .
  ex:RFQ-1002 rfq:hasTechnicalRequirement ?s . { ?s a rfq:MaterialSpec } UNION { ?s a rfq:FinishSpec }
}`;
export function completeRFQ() { return sparql(COMPLETE_RFQ_ASK); }
