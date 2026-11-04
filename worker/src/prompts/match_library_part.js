export const system = "You match a requested part against a small library of known parts. Reply only with JSON matching the schema.";
export const user = (input) => `Request: ${JSON.stringify(input?.request ?? input)}\nLibrary: ${JSON.stringify(input?.library ?? [])}`;
export const schema = { type: "object", properties: {
  best_match_id: { type: "string" }, similarity: { type: "number" }, reason: { type: "string" } },
  required: ["best_match_id", "similarity"] };
