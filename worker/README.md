# rfq-pla Worker

Backend for the PLA demo at pla.chriscouch.net. **No public route** (`workers_dev = false`); it is reached only
through the Pages site's `PLA` service binding, after the "Secret?" gate in `functions/_middleware.js`.

Owners: Cloud Manager (infra: everything except tools/prompts) · T800 (`src/tools/*`, `src/prompts/*`).

## API (via https://pla.chriscouch.net, requires the `pla_session` cookie)
- `POST /api/run` body `{ "tool": "parse_rfq_document" | "match_library_part" | "explain_quote", "input": <any JSON> }`
  → `202 { runId }`. Optional `Idempotency-Key` header (8–64 chars `[\w-]`) → same runId, no duplicate run.
- `GET /api/run/:runId` → `{ runId, tool, status: queued|complete|errored, workflow, output, error }`.
- `401` no/invalid cookie · `429` per-IP rate limit · `503 {"message":"The demo is resting for today. Please try again tomorrow."}` budget exhausted.

## Tool contract (for T800)
Each `src/tools/<name>.js` exports:
```js
export async function run({ env, input, ai }) { /* return JSON-serialisable output */ }
```
- `input`: the request's `input` (untrusted, ≤ 20k chars serialised).
- `ai.json({ system, user, schema, maxTokens? })` → parsed object. Calls Workers AI
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast` with `response_format: {type:"json_schema"}`; `max_tokens` is clamped to
  `MAX_OUTPUT_TOKENS` (1024). **Always call the model through `ai`**, never `env.AI` directly, so usage is metered.
- Throwing = the step is retried (2 retries, exponential backoff from 2 s, 60 s timeout per attempt). Tools must be
  safe to re-run. Prompts live in `src/prompts/<name>.js` (`system`, `user(input)`, `schema`).
- Adding a tool: create the file and register it in `src/tools/index.js`.

## Budget ($20/day hard cap, UTC day) — `src/constants.js`, `src/budget-core.js`
Estimate per run = (chars/3 + 600 prompt tokens) × $0.293/M + 1024 × $2.253/M, × 1.25 safety × 3 attempts
(≈ $0.009 for a small input). The `Budget` Durable Object (single instance "global") atomically **reserves** the
estimate before the Workflow starts and refuses if `spent + reserved + estimate > cap`; after the run it **settles**
to actual token usage (failed runs keep the full estimate). The free daily neuron allowance is ignored. Also:
6 req/min and 100 req/day per IP, 3000 runs/day global. `DAILY_BUDGET_USD` var can only lower the cap.

## Bindings / resources
| Binding | Resource |
|---|---|
| `AI` | Workers AI |
| `RUN_WORKFLOW` | Workflow `rfq-pla-run` (class `RunWorkflow`, instance id = runId) |
| `BUDGET` | Durable Object `Budget` (SQLite-backed) |
| `RUNS_DB` | D1 `pla-runs` (migrations in `migrations/`) |
| secrets | `COOKIE_KEY` (= Pages production `COOKIE_KEY`), `COOKIE_KEY_PREVIEW` (= Pages preview `COOKIE_KEY`) |

**Pages side (not in repo files):** the `rfq-demo` Pages project (Cloudflare name kept; Git source is `supergus/pla-demo`) has service binding `PLA → rfq-pla` on both
production and preview, set via the Pages API (`PATCH /accounts/:id/pages/projects/rfq-demo`, `deployment_configs.*.services`).
If COOKIE_KEY is rotated on Pages, set the matching Worker secret too.

## Deploy / test
`cd worker && npm ci && node --test tests/*.test.mjs`. Merges to `main` touching `worker/**` run
`.github/workflows/deploy-worker.yml` (tests → D1 migrations → `wrangler deploy`). PRs run tests only.
