// parse_rfq_document (owner: T800). Input: RFQ text (string or {text}). Output mirrors rfq-agents PARSE_SCHEMA
// plus `found`/`inferred`, `missing_fields`, `ambiguities`, `low_confidence`. Throws (=> workflow retry) on invalid output.
import * as P from "../prompts/parse_rfq_document.js";

export const FIELD_CONFIDENCE_MIN = 0.7;
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

export function validate(d, text) {
  const errs = [];
  if (!d || typeof d !== "object") throw new Error("parse_rfq_document: model returned no object");
  if (typeof d.rfq_id !== "string" || !d.rfq_id.trim()) errs.push("rfq_id missing");
  if (!Array.isArray(d.lines) || d.lines.length === 0) errs.push("no lines");
  const digits = new Set((text.match(/\d[\d,.]*/g) || []).map((n) => n.replace(/,/g, "").replace(/\.0+$/, "")));
  (d.lines || []).forEach((ln, i) => {
    if (!ln || typeof ln.part !== "string" || !ln.part.trim()) errs.push(`line ${i + 1}: part missing`);
    if (!Array.isArray(ln?.quantities) || ln.quantities.length === 0) errs.push(`line ${i + 1}: quantity missing`);
    for (const q of ln?.quantities || []) {
      if (!Number.isInteger(q) || q < 1) errs.push(`line ${i + 1}: quantity ${q} is not a positive integer`);
      else if (!digits.has(String(q))) errs.push(`line ${i + 1}: quantity ${q} not found in source text`);
    }
  });
  if (d.incoterm && !P.INCOTERMS.includes(d.incoterm)) errs.push(`incoterm ${d.incoterm} not allowed`);
  if (d.delivery_date && !/^\d{4}-\d{2}-\d{2}$/.test(d.delivery_date)) errs.push("delivery_date not YYYY-MM-DD");
  if (errs.length) throw new Error("parse_rfq_document: invalid model output: " + errs.join("; "));
}

export async function run({ env, input, ai }) {
  const text = String(typeof input === "string" ? input : input?.text ?? "");
  if (!text.trim()) throw new Error("parse_rfq_document: input text is empty");
  const raw = await ai.json({ system: P.system, user: P.user(text), schema: P.schema });
  const d = { ...raw };
  for (const k of ["revision", ...P.FIELDS]) d[k] = typeof d[k] === "string" && d[k].trim() ? d[k].trim() : null;
  if (d.incoterm) d.incoterm = d.incoterm.toUpperCase();
  d.lines = (raw?.lines || []).map((l) => ({ part: l?.part, description: l?.description || null,
    quantities: [...new Set((l?.quantities || []).map((q) => (typeof q === "string" ? Number(q.replace(/,/g, "")) : q)))] }));
  validate(d, text);

  const t = norm(text), found = [], inferred = [];
  for (const k of ["rfq_id", "revision", ...P.FIELDS]) {
    if (d[k] == null) continue;
    (t.includes(norm(d[k])) ? found : inferred).push(k);
  }
  const conf = raw.confidence || {};
  const low_confidence = Object.entries(conf).filter(([k, c]) => d[k] != null && typeof c === "number" && c < FIELD_CONFIDENCE_MIN).map(([k]) => k);
  return {
    rfq_id: d.rfq_id.trim(), revision: d.revision, customer: d.customer, payment_terms: d.payment_terms,
    incoterm: d.incoterm, delivery_date: d.delivery_date, drawing: d.drawing, material_spec: d.material_spec,
    finish_spec: d.finish_spec, lines: d.lines, confidence: conf,
    found, inferred, // values copied verbatim from the text vs. normalised/inferred by the model
    missing_fields: P.FIELDS.filter((k) => d[k] == null),
    low_confidence, ambiguities: Array.isArray(raw.ambiguities) ? raw.ambiguities.map(String) : [],
  };
}
