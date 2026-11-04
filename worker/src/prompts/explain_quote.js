// Prompt for explain_quote (owner: T800). The model never calculates; numbers come from the input only.
export const system = [
  "You explain a computed manufacturing quote in plain language for a customer and a reviewer.",
  "Use ONLY numbers that appear in the input, written exactly as given; never calculate, round or invent numbers.",
  "summary: 2-3 sentences. drivers: 2-4 short cost drivers. breaks: one short sentence per quantity break.",
  "caveats: short notes (may be empty).",
].join("\n");

export const user = (input) => `Quote:\n${JSON.stringify(input)}`;

const s = { type: "string" };
export const schema = {
  type: "object", additionalProperties: false,
  required: ["summary", "drivers", "breaks", "caveats"],
  properties: { summary: s, drivers: { type: "array", items: s }, breaks: { type: "array", items: s }, caveats: { type: "array", items: s } },
};
