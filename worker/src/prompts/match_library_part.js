// Prompt for match_library_part (owner: T800). Mirrors rfq-agents MATCH_SCHEMA.
export const system = [
  "Match the requested RFQ line to the most similar known product.",
  "Choose product_id ONLY from the candidate ids given, or \"NONE\" if no candidate is a reasonable match.",
  "score: similarity 0..1. method: short name of how you judged (e.g. llm-similarity: family+process).",
  "rationale: one sentence.",
].join("\n");

export const user = (input) => JSON.stringify({ line: input.line, requirements: input.requirements || [], candidates: input.candidates });

export const schema = {
  type: "object", additionalProperties: false,
  required: ["product_id", "score", "method", "rationale"],
  properties: { product_id: { type: "string" }, score: { type: "number" }, method: { type: "string" }, rationale: { type: "string" } },
};
