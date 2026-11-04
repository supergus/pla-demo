import { MODEL, MAX_OUTPUT_TOKENS } from "./constants.js";
// Helper passed to every tool as `ai`. Tracks token usage for budget reconciliation.
export function makeAi(env) {
  const usage = { prompt_tokens: 0, completion_tokens: 0, calls: 0 };
  return {
    usage,
    async json({ system, user, schema, maxTokens = MAX_OUTPUT_TOKENS }) {
      const r = await env.AI.run(MODEL, {
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: schema },
        max_tokens: Math.min(maxTokens, MAX_OUTPUT_TOKENS),
      });
      usage.calls++;
      usage.prompt_tokens += r?.usage?.prompt_tokens || 0;
      usage.completion_tokens += r?.usage?.completion_tokens || 0;
      const out = r?.response;
      return typeof out === "string" ? JSON.parse(out) : out;
    },
  };
}
