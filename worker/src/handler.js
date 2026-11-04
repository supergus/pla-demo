// HTTP handling, dependency-injected so it is unit-testable in node.
import { hasSession } from "./gate.js";
import { estimateUsd, capUsd } from "./cost.js";
import { RESTING_MSG, MAX_INPUT_CHARS } from "./constants.js";
import { TOOLS } from "./tools/index.js";

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", ...extra } });

export async function handle(request, env, nowMs = Date.now()) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return json(404, { error: "not found" });
  if (!(await hasSession(request, env, nowMs))) return json(401, { error: "unauthorized" });
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const budget = env.BUDGET.get(env.BUDGET.idFromName("global"));

  if (url.pathname === "/api/run" && request.method === "POST") {
    let body; try { body = await request.json(); } catch { return json(400, { error: "invalid JSON" }); }
    const { tool, input } = body || {};
    if (!Object.hasOwn(TOOLS, tool)) return json(400, { error: "unknown tool", tools: Object.keys(TOOLS) });
    if (JSON.stringify(input ?? null).length > MAX_INPUT_CHARS) return json(413, { error: "input too large" });
    const idem = request.headers.get("Idempotency-Key");
    const runId = idem && /^[\w-]{8,64}$/.test(idem) ? "r-" + idem : "r-" + crypto.randomUUID();
    const existing = await env.RUNS_DB.prepare("SELECT id FROM runs WHERE id=?").bind(runId).first();
    if (existing) return json(200, { runId, deduplicated: true });
    const est = estimateUsd(input);
    const r = await budget.reserve({ ip, estUsd: est, capUsd: capUsd(env), nowMs, id: runId });
    if (!r.ok) {
      if (r.reason === "budget") return json(503, { error: "resting", message: RESTING_MSG }, { "Retry-After": "3600" });
      return json(429, { error: "rate_limited", message: "Too many requests. Please slow down." }, r.retryAfter ? { "Retry-After": String(r.retryAfter) } : {});
    }
    const ts = new Date(nowMs).toISOString();
    await env.RUNS_DB.prepare("INSERT INTO runs (id, tool, ip, status, est_usd, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").bind(runId, tool, ip, "queued", est, ts, ts).run();
    try {
      await env.RUN_WORKFLOW.create({ id: runId, params: { runId, tool, input } });
    } catch (e) {
      await budget.settle({ id: runId, actualUsd: 0 });
      await env.RUNS_DB.prepare("UPDATE runs SET status='errored', error=? WHERE id=?").bind("create failed", runId).run();
      return json(500, { error: "could not start run" });
    }
    return json(202, { runId });
  }

  const m = url.pathname.match(/^\/api\/run\/(r-[\w-]{8,80})$/);
  if (m && request.method === "GET") {
    const row = await env.RUNS_DB.prepare("SELECT id, tool, status, output, error, created_at, updated_at FROM runs WHERE id=?").bind(m[1]).first();
    if (!row) return json(404, { error: "no such run" });
    let wf = null;
    if (row.status === "queued") { try { wf = (await (await env.RUN_WORKFLOW.get(m[1])).status())?.status; } catch {} }
    return json(200, { runId: row.id, tool: row.tool, status: row.status, workflow: wf, output: row.output ? JSON.parse(row.output) : null, error: row.error });
  }
  return json(404, { error: "not found" });
}
