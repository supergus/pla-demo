import { handle } from "./handler.js";
export { Budget } from "./budget.js";
export { RunWorkflow } from "./workflow.js";
export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (e) { console.error("rfq-pla error", e?.stack || e); return new Response(JSON.stringify({ error: "internal" }), { status: 500, headers: { "Content-Type": "application/json" } }); }
  },
};
