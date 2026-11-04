// PLACEHOLDER tool (owned by T800). Contract: see worker/README.md.
import * as P from "../prompts/explain_quote.js";
export async function run({ env, input, ai }) {
  return ai.json({ system: P.system, user: P.user(input), schema: P.schema });
}
