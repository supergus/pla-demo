// Client for the rfq-pla Worker (same origin, behind the "Secret?" gate). Shapes from worker/src/handler.js:
// POST /api/run {tool,input} -> 202 {runId} | 200 {runId, deduplicated}; GET /api/run/:id -> {runId, tool, status: queued|complete|errored, workflow, output, error}
// Errors: 401 {error}, 429 {error, message}, 503 {error:"resting", message}. Never throws: returns {ok, output, ...} or {ok:false, reason, message}.
export const MODEL_LABEL = "Llama 3.3 70B";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runTool(tool, input, key, { timeoutMs = window.PLA_API_TIMEOUT_MS ?? 90000, pollMs = window.PLA_API_POLL_MS ?? 1500 } = {}) {
  const t0 = performance.now(), polls = [];
  const fail = (reason, message, extra = {}) => ({ ok: false, reason, message, ms: Math.round(performance.now() - t0), polls: polls.length, ...extra });
  let res, body;
  try {
    res = await fetch("api/run", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ tool, input }) });
    body = await res.json().catch(() => ({}));
  } catch (e) { return fail("network", `Network error: ${e.message || e}`); }
  if (res.status === 503) return fail("resting", body.message || "The demo is resting for today. Please try again tomorrow.", { status: 503 });
  if (res.status === 429) return fail("rate_limited", body.message || "Too many requests. Please slow down.", { status: 429 });
  if (res.status === 401) return fail("unauthorized", "Your session has expired. Reload the page and enter the secret again.", { status: 401 });
  if (!res.ok || !body.runId) return fail("http", `API returned ${res.status}${body.error ? ` (${body.error})` : ""}`, { status: res.status });
  const runId = body.runId, deduplicated = !!body.deduplicated;
  while (performance.now() - t0 < timeoutMs) {
    await sleep(pollMs);
    let r, g;
    try { r = await fetch("api/run/" + encodeURIComponent(runId), { credentials: "same-origin", cache: "no-store" }); g = await r.json().catch(() => ({})); }
    catch (e) { polls.push("network"); continue; } // transient: keep polling until timeout
    if (r.status === 401) return fail("unauthorized", "Your session has expired. Reload the page and enter the secret again.", { status: 401, runId });
    if (!r.ok) { polls.push(r.status); continue; }
    polls.push(g.workflow || g.status);
    if (g.status === "complete") return { ok: true, runId, deduplicated, output: g.output, workflow: g.workflow, ms: Math.round(performance.now() - t0), polls: polls.length, usage: g.usage ?? null, attempts: g.attempts ?? null };
    if (g.status === "errored") return fail("errored", `Worker run errored after its retries: ${g.error || "unknown error"}`, { runId });
  }
  return fail("timeout", `No result within ${Math.round(timeoutMs / 1000)}s`, { runId });
}
