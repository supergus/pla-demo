// Prompt for parse_rfq_document (owner: T800). Field names mirror pla-agents PARSE_SCHEMA.
export const INCOTERMS = ["EXW", "FCA", "FOB", "CIF", "DAP", "DDP"];
export const FIELDS = ["customer", "payment_terms", "incoterm", "delivery_date", "drawing", "material_spec", "finish_spec"];

export const system = [
  "You extract a manufacturing RFQ (request for quote) into JSON.",
  "Rules: copy values from the text; use \"\" for anything not stated; never guess.",
  "rfq_id: the RFQ number, e.g. RFQ-1003. revision: letter/number only, e.g. A.",
  "lines: one per part. quantities: EVERY quantity or volume break requested for that part, as integers (\"2,500\" -> 2500).",
  "incoterm: one of EXW,FCA,FOB,CIF,DAP,DDP or \"\". delivery_date: YYYY-MM-DD or \"\".",
  "confidence: 0..1 per field; use below 0.7 when the text is tentative (e.g. a question mark or 'will confirm').",
  "ambiguities: short notes on anything tentative or unclear.",
].join("\n");

export const user = (input) => `RFQ text:\n${String(typeof input === "string" ? input : input?.text ?? "").slice(0, 15000)}`;

const str = { type: "string" };
const num = { type: "number" };
export const schema = {
  type: "object", additionalProperties: false,
  required: ["rfq_id", "revision", "customer", "payment_terms", "incoterm", "delivery_date", "drawing",
    "material_spec", "finish_spec", "lines", "confidence", "ambiguities"],
  properties: {
    rfq_id: str, revision: str, customer: str, payment_terms: str, incoterm: str, delivery_date: str,
    drawing: str, material_spec: str, finish_spec: str,
    lines: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["part", "description", "quantities"],
      properties: { part: str, description: str, quantities: { type: "array", items: { type: "integer" } } } } },
    confidence: { type: "object", additionalProperties: false,
      required: ["customer", "incoterm", "delivery_date", "material_spec", "lines"],
      properties: { customer: num, incoterm: num, delivery_date: num, material_spec: num, lines: num } },
    ambiguities: { type: "array", items: str },
  },
};
