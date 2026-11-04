import { WorkflowEntrypoint } from "cloudflare:workers";
import { TOOLS } from "./tools/index.js";
import { makeAi } from "./ai.js";
import { actualUsd } from "./cost.js";

// One instance per run (instance id = runId = idempotency key). Each step is checkpointed.
export class RunWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { runId, tool, input } = event.payload;
    const budget = this.env.BUDGET.get(this.env.BUDGET.idFromName("global"));
    let result;
    try {
      result = await step.do("tool:" + tool, { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" }, timeout: "60 seconds" }, async () => {
        const ai = makeAi(this.env);
        const output = await TOOLS[tool].run({ env: this.env, input, ai });
        return { output, usage: ai.usage };
      });
    } catch (e) {
      await step.do("settle", () => budget.settle({ id: runId, actualUsd: null }));  // keep full estimate
      await step.do("save", () => save(this.env, runId, "errored", null, String(e?.message || e).slice(0, 500), null));
      throw e;
    }
    const usd = actualUsd(result.usage);
    await step.do("settle", () => budget.settle({ id: runId, actualUsd: usd }));
    await step.do("save", () => save(this.env, runId, "complete", result.output, null, usd));
    return result.output;
  }
}

async function save(env, id, status, output, error, usd) {
  await env.RUNS_DB.prepare("UPDATE runs SET status=?, output=?, error=?, actual_usd=?, updated_at=? WHERE id=?")
    .bind(status, output == null ? null : JSON.stringify(output), error, usd, new Date().toISOString(), id).run();
  return true;
}
