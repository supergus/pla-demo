export const system = "You extract structured fields from an RFQ (request for quote). Reply only with JSON matching the schema.";
export const user = (input) => `RFQ text:\n${String(input?.text ?? JSON.stringify(input))}`;
export const schema = { type: "object", properties: {
  part_name: { type: "string" }, quantity: { type: "number" }, material: { type: "string" }, notes: { type: "string" } },
  required: ["part_name"] };
