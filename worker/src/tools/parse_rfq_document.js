// PLACEHOLDER tool (owned by T800). Contract: see worker/README.md.
import * as P from "../prompts/parse_rfq_document.js";
export async function run({ env, input, ai }) {
  return ai.json({ system: P.system, user: P.user(input), schema: P.schema });
}
