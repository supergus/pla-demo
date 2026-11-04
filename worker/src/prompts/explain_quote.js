export const system = "You explain a manufacturing quote to a buyer in plain language. Reply only with JSON matching the schema.";
export const user = (input) => `Quote: ${JSON.stringify(input)}`;
export const schema = { type: "object", properties: {
  summary: { type: "string" }, cost_drivers: { type: "array", items: { type: "string" } } },
  required: ["summary"] };
