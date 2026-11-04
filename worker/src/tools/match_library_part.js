// match_library_part (owner: T800). Input: { line: string|{part,description}, requirements?: string[],
// candidates?: { [productId]: label } }. Default candidates = products with a BOM in public/data (BRK-100).
// Output: a SimilarityMatch record (score + method are facts, per Chris's rule). Hallucinated ids => throw/retry.
import * as P from "../prompts/match_library_part.js";

export const MATCH_SCORE_MIN = 0.8;
export const DEFAULT_CANDIDATES = { "BRK-100": "BRK-100 welded mounting bracket" };

export function validate(d, candidates) {
  if (!d || typeof d !== "object") throw new Error("match_library_part: model returned no object");
  if (typeof d.product_id !== "string" || !d.product_id) throw new Error("match_library_part: product_id missing");
  if (d.product_id !== "NONE" && !(d.product_id in candidates))
    throw new Error(`match_library_part: model proposed unknown product ${JSON.stringify(d.product_id)}`);
  if (typeof d.score !== "number" || !(d.score >= 0 && d.score <= 1)) throw new Error(`match_library_part: score ${d.score} not in 0..1`);
  if (typeof d.method !== "string" || !d.method.trim()) throw new Error("match_library_part: method missing");
}

export async function run({ env, input, ai }) {
  const line = typeof input?.line === "string" ? input.line : [input?.line?.part, input?.line?.description].filter(Boolean).join(" ");
  if (!line) throw new Error("match_library_part: input.line is required");
  const c = input?.candidates;
  const candidates = c && typeof c === "object" && !Array.isArray(c) && Object.keys(c).length ? c
    : Array.isArray(c) && c.length ? Object.fromEntries(c.map((x) => [x.id, x.label ?? x.id])) : DEFAULT_CANDIDATES;
  const d = await ai.json({ system: P.system, user: P.user({ line, requirements: input?.requirements, candidates }), schema: P.schema });
  validate(d, candidates);
  const none = d.product_id === "NONE";
  const written = !none && d.score >= MATCH_SCORE_MIN;
  return {
    line, product: none ? null : d.product_id, matchedProduct: none ? null : `ex:${d.product_id}`,
    score: d.score, method: `${d.method.trim()} (Llama 3.3 70B)`, rationale: d.rationale || null,
    confidence: none ? "none" : d.score >= 0.85 ? "high" : d.score >= MATCH_SCORE_MIN ? "medium" : "low",
    written, // false => estimator must confirm (raise an Issue)
  };
}
