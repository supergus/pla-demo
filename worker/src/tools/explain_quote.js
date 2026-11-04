// explain_quote (owner: T800). Input: computed quote { quote, breaks:[{line,quantity,unit_price,nre,freight,total}], ... }.
// The LLM never does arithmetic: every number in its text must appear in the input, else throw (=> retry).
import * as P from "../prompts/explain_quote.js";

const NUM = /(?<![\w.,-])\$?(\d[\d,]*(?:\.\d+)?)/g;
const norm = (x) => { const n = Number(String(x).replace(/,/g, "")); return Number.isFinite(n) ? String(n) : null; };

export function allowedNumbers(input) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === "number") out.add(norm(v));
    else if (typeof v === "string") for (const m of v.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(norm(m[0]));
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(input);
  return out;
}

export function validate(d, input) {
  if (!d || typeof d.summary !== "string" || d.summary.trim().length < 10) throw new Error("explain_quote: summary missing");
  const allowed = allowedNumbers(input);
  const texts = [d.summary, ...(d.drivers || []), ...(d.breaks || []), ...(d.caveats || [])];
  const invented = [];
  for (const t of texts) for (const m of String(t).matchAll(NUM)) if (!allowed.has(norm(m[1]))) invented.push(m[0]);
  if (invented.length) throw new Error(`explain_quote: text contains numbers not in the computed quote: ${invented.join(", ")}`);
}

export async function run({ env, input, ai }) {
  if (!input || typeof input !== "object" || !Array.isArray(input.breaks) || !input.breaks.length)
    throw new Error("explain_quote: input.breaks (computed quote) is required");
  const d = await ai.json({ system: P.system, user: P.user(input), schema: P.schema });
  validate(d, input);
  const arr = (a) => (Array.isArray(a) ? a.map(String) : []);
  return { quote: input.quote ?? null, summary: d.summary.trim(), drivers: arr(d.drivers), breaks: arr(d.breaks), caveats: arr(d.caveats) };
}
