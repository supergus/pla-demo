# Repo guide: pla-demo

A map of this repository for auditors (CS IT) and new contributors. Last checked against `main` on 2026-11-09.

> **Demo status.** This is an **early proof-of-concept demo** of the agentic RFQ-to-quote workflow that preceded the production **CS Agent Orchestration Suite**. It may be retired once the suite is in production. **Inference (flagged):** the live console idea here roughly became **Agent Orchard** (run console) and **Agent Buffet** (quote-instance runs); ontology / Graph View work moved to **Leaf Tender**. This repo is **not** part of the production suite (`leaf-tender`, `agent-orchard`, `agent-buffet`, `suite-landing`).

**Names used here.** The **CS Agent Orchestration Suite** is the production software in those four repos. **CS** is the company the suite is being built for; **CS IT** is that company's IT organisation. Today this demo and the suite both run on Cloudflare with sample / fictional data only.

## Purpose

`pla-demo` is the live **PLA management console** at https://pla.chriscouch.net. It runs a scripted Program Lifecycle Agent (PLA) RFQ-to-quote demo in the browser on sample RFQ-1002 (tutorial ontology from `pla-agents`). Optional AI steps call Worker `rfq-pla` (Workers AI) after a shared-secret gate; otherwise the console uses canned / browser-local output. Nothing is uploaded and no customer data is used.

It also serves a **frozen** static quote-ontology viewer at `/actual/` (historical pin from archived `pcaq-viewer`) and **302-redirects** `/leaf-tender/*` to https://leaftender.chriscouch.net.

## Where it runs

| Item | Value |
|---|---|
| Cloudflare Pages project | `rfq-demo` (legacy name; Git source is `supergus/pla-demo`) |
| Custom domain | `pla.chriscouch.net` |
| Static output | `public/` |
| Pages Functions | `functions/_middleware.js` ("Secret?" gate) + `functions/_gate.js` |
| Worker (no public URL) | `rfq-pla` in `worker/` (`workers_dev` and `preview_urls` off) |
| Pages → Worker | Service binding `PLA` → `rfq-pla` (configured on the Pages project via API, not in repo files) |
| D1 (Pages) | binding `DB` — access-log for the gate (schema not in this repo's migrations) |
| D1 (Worker) | `pla-runs`, binding `RUNS_DB` (`worker/migrations/`) |
| Other Worker bindings | Workers AI (`AI`), Durable Object `Budget`, Workflow `rfq-pla-run` |
| Login | Shared-secret form ("Secret?"); HMAC session cookie `pla_session` (3 days). **Not** Cloudflare Access / suite user list |
| Secrets (names only) | Pages: `PLA_SECRET`, `COOKIE_KEY`. Worker: `COOKIE_KEY`, `COOKIE_KEY_PREVIEW` (must match Pages prod / preview) |
| Optional var | `DAILY_BUDGET_USD` (can only **lower** the $20/day AI spend cap) |
| GitHub Actions secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (deploy workflow only) |

## Folder tree

```
pla-demo/
├── .github/workflows/   tests + Worker deploy
├── functions/           Pages Functions: Secret? gate
├── public/              Pages site (console + frozen /actual/)
│   ├── actual/          frozen pcaq-viewer pin (fictional demo data)
│   ├── data/            tutorial ontology + sample RFQs + precomputed results
│   └── vendor/          oxigraph / shacl / vis-network (no CDN)
├── tests/               Node gate / middleware / redirect tests
├── tools/               precompute, e2e, vendor build, retired sync-actual
└── worker/              rfq-pla Worker (AI tools + budget)
```

## Every tracked file

### Root
| File | What it is for |
|---|---|
| `.github/workflows/deploy-worker.yml` | On `main` pushes touching `worker/**` / gate helpers: test Worker, apply D1 migrations, `wrangler deploy`. PRs run tests only. |
| `.github/workflows/tests.yml` | Cost + gate + middleware + `/actual/` gated + Leaf redirect tests on every push / PR. |
| `.gitignore` | Ignores local junk. |
| `README.md` | Project readme: what the console shows, `/actual/`, Leaf redirect, develop / test, related repos. |
| `REPO-GUIDE.md` | This file. |

### functions/
| File | What it is for |
|---|---|
| `functions/_gate.js` | Pure helpers: constant-time compare, HMAC session sign/verify, safe `next` path, IPv6 /64 rate key. |
| `functions/_middleware.js` | Gate: login form, rate limit, access_log, session cookie; forwards `/api/*` to `env.PLA`; redirects `/leaf-tender/*` without requiring a session. |

### public/ (console)
| File | What it is for |
|---|---|
| `public/_headers` | Sets `X-Robots-Tag: noindex, nofollow` on every path. |
| `public/index.html` | Console landing / shell. |
| `public/app.js` | Browser PLA run UI (stages, tools, graph, quote, localStorage). |
| `public/api.js` | Calls `/api/*` (Worker) when the session is present; canned fallback otherwise. |
| `public/cost.js` | Browser port of the ontology quote calculator. |
| `public/kb.js` | Loads Turtle / queries into Oxigraph and runs SPARQL / SHACL in the browser. |
| `public/style.css` | Console styles. |
| `public/robots.txt` | Disallow crawlers. |
| `public/vendor/VERSIONS.txt` | Pinned versions of vendored libraries. |
| `public/vendor/oxigraph/web.js` | Oxigraph WASM JS glue. |
| `public/vendor/oxigraph/web_bg.wasm` | Oxigraph WebAssembly binary. |
| `public/vendor/rdf-shacl.js` | Bundled N3 + rdf-ext + shacl-engine. |
| `public/vendor/vis-network.min.js` | Graph drawing library. |

### public/data/ (tutorial sample graph)
| File | What it is for |
|---|---|
| `public/data/ontology/rfq.ttl` | Root OWL module (`owl:imports` the others). |
| `public/data/ontology/rfq-core.ttl` | Core RFQ classes / properties. |
| `public/data/ontology/rfq-provenance.ttl` | Provenance vocabulary. |
| `public/data/ontology/rfq-package.ttl` | RFQ package / completeness vocabulary. |
| `public/data/ontology/rfq-bom.ttl` | BOM / make-vs-buy vocabulary. |
| `public/data/ontology/rfq-library.ttl` | Component library vocabulary. |
| `public/data/ontology/rfq-costing.ttl` | Costing / rates vocabulary. |
| `public/data/ontology/rfq-pla.ttl` | PLA run / tools / issues vocabulary. |
| `public/data/reference.ttl` | Sample library, routings, work centers, rate tables. |
| `public/data/rfq-1001.ttl` | Complete sample RFQ (worked example). |
| `public/data/rfq-1002-incomplete.ttl` | Incomplete sample RFQ used by the console run. |
| `public/data/pla-run-1002.ttl` | Sample PLA run graph (for CQ9–CQ12). |
| `public/data/quote-results.ttl` | Build-time quote results (PROV-linked). |
| `public/data/rfq-completeness.ttl` | SHACL completeness shapes (copy). |
| `public/data/shacl-results.json` | Precomputed pySHACL replay. |
| `public/data/reasoner-results.json` | Precomputed HermiT / ROBOT replay. |
| `public/data/queries/cq1-rfq-completeness.rq` … `cq12-rfq-line-matches.rq` | Twelve competency SPARQL queries (browser SPARQL panel). |

### public/actual/ (frozen pcaq-viewer pin)
| File | What it is for |
|---|---|
| `public/actual/SOURCE.txt` | Pin record: `supergus/pcaq-viewer@9d9cf10`. Do not re-sync without an explicit go-ahead. |
| `public/actual/index.html` | Frozen PCAQ ontology browser shell. |
| `public/actual/app.js` | Frozen viewer behaviour. |
| `public/actual/style.css` | Frozen viewer styles. |
| `public/actual/data/pcaq.ttl` | Structural PCAQ OWL (thin quote-workbook ontology). |
| `public/actual/data/pcaq-demo.ttl` | Fictional demo individuals only. |
| `public/actual/data/pcaq-shapes.ttl` | SHACL shapes for the demo. |
| `public/actual/data/queries/index.txt` | Query index for the dropdown. |
| `public/actual/data/queries/q01-*.rq` … `q29-*.rq` | Twenty-nine competency SPARQL queries (yearly prices through sourcing restrictions). |
| `public/actual/vendor/*` | Same vendored stack as the console (VERSIONS, oxigraph, rdf-shacl, vis-network). |

### tests/
| File | What it is for |
|---|---|
| `tests/gate.test.mjs` | Unit tests for `_gate.js` helpers. |
| `tests/middleware.test.mjs` | Gate login, rate limit, session, fail-closed behaviour. |
| `tests/actual-gated.test.mjs` | `/actual/` is behind the same gate. |
| `tests/leaf-tender-gated.test.mjs` | `/leaf-tender` redirect behaviour with / without session. |
| `tests/leafTenderRedirect.test.mjs` | Exact redirect target / path stripping. |

### tools/
| File | What it is for |
|---|---|
| `tools/e2e.py` | Playwright headless end-to-end of the console. |
| `tools/precompute.py` | Regenerates `shacl-results.json` from a `pla-agents` ontology tree. |
| `tools/precompute_reasoner.py` | Regenerates `reasoner-results.json` via ROBOT / HermiT. |
| `tools/sync-actual.sh` | **Retired** (exits 1): used to copy `pcaq-viewer` into `public/actual/`. |
| `tools/test-cost.mjs` | Asserts `public/cost.js` matches the worked-example numbers. |
| `tools/vendor/build.sh` | Rebuilds `public/vendor/rdf-shacl.js`. |
| `tools/vendor/entry-shacl.mjs` | esbuild entry for the SHACL bundle. |
| `tools/vendor/package.json` | Dependencies for the vendor build. |
| `tools/vendor/package-lock.json` | Locked vendor-build dependency versions. |

### worker/
| File | What it is for |
|---|---|
| `worker/.gitignore` | Ignores Worker `node_modules/` / `.wrangler/`. |
| `worker/README.md` | Worker API, budget, bindings, deploy notes. |
| `worker/package.json` | Worker deps (`wrangler`); `test` / `deploy` scripts. |
| `worker/package-lock.json` | Locked Worker dependency versions. |
| `worker/wrangler.jsonc` | Worker name `rfq-pla`, AI / D1 / DO / Workflow bindings; secret **names** in a comment. |
| `worker/migrations/0001_runs.sql` | D1 `runs` table for queued / complete / errored tool runs. |
| `worker/src/index.js` | Worker entry: routes + exports `Budget` DO and `RunWorkflow`. |
| `worker/src/handler.js` | `POST /api/run`, `GET /api/run/:id`; rate limits; creates Workflow. |
| `worker/src/gate.js` | Verifies Pages session cookie (`COOKIE_KEY` or preview key). |
| `worker/src/workflow.js` | Workflow steps: reserve budget → run tool → settle. |
| `worker/src/ai.js` | Metered Workers AI JSON-schema calls (Llama 3.3 70B). |
| `worker/src/budget.js` | Durable Object budget binder. |
| `worker/src/budget-core.js` | Pure budget math ($20/day hard cap). |
| `worker/src/constants.js` | Model id, token/price assumptions, caps. |
| `worker/src/cost.js` | Per-run cost estimate from input size. |
| `worker/src/tools/index.js` | Registers AI tools. |
| `worker/src/tools/parse_rfq_document.js` | AI tool: parse RFQ text → structured fields. |
| `worker/src/tools/match_library_part.js` | AI tool: similarity match to library part. |
| `worker/src/tools/explain_quote.js` | AI tool: explain a quote breakdown. |
| `worker/src/prompts/*.js` | System / user / schema prompts for each AI tool. |
| `worker/tests/tools.test.mjs` | Tool unit tests (no live model). |
| `worker/tests/worker.test.mjs` | Handler / gate / budget integration tests with stubs. |

## Run tests and deploy

```
# Pages / gate tests (repo root)
node tools/test-cost.mjs
node tests/gate.test.mjs
node tests/middleware.test.mjs
node tests/actual-gated.test.mjs
node tests/leaf-tender-gated.test.mjs
node tests/leafTenderRedirect.test.mjs

# Worker
cd worker && npm ci && npm test
# Deploy (also runs on main via Actions when worker/** changes):
# npx wrangler d1 migrations apply pla-runs --remote && npx wrangler deploy
```

Pages itself is deployed by the Cloudflare Pages Git integration on `main` (project `rfq-demo`). This docs-only change does not require a Worker redeploy.

`main` is protected: PRs need the **Grok Bot QC** commit status (and the `tests` workflow).

## How auth works

1. Unauthenticated browser hits get the "Secret?" form (`functions/_middleware.js`).
2. Correct `PLA_SECRET` (constant-time compare) sets an HMAC-signed `pla_session` cookie using `COOKIE_KEY` (3-day TTL). Failures are rate-limited (5 / 15 min per IP, IPv6 /64) and logged to D1 `access_log` when `DB` is bound.
3. Authenticated `/api/*` is forwarded to Worker `rfq-pla` over the `PLA` service binding; the Worker re-checks the cookie.
4. `/leaf-tender/*` redirects to Leaf Tender **without** needing a session (suite login lives there).
5. Missing secrets fail closed (401).

## Where to look (audit topics)

| Topic | Look here |
|---|---|
| Authentication (demo gate) | `functions/_middleware.js`, `functions/_gate.js`, `worker/src/gate.js` |
| Authorization | Shared secret only; no per-user roles. Suite user list is **not** used here |
| Service-to-service | Pages `PLA` binding → Worker `rfq-pla` (cookie still required) |
| Data storage | Worker D1 `pla-runs`; Pages D1 access_log; browser `localStorage` for console run state |
| Secrets | Names in `worker/wrangler.jsonc` comment + `worker/README.md`. Values only in Cloudflare / Actions |
| LLM calls and cost caps | `worker/src/ai.js`, `budget*.js`, `constants.js` — **$20/day** hard cap UTC |
| Customer / RFQ data | Sample / fictional only under `public/data/` and `public/actual/data/` |
| AWS move | Not written for this demo; production suite has lift-and-shift guides under `apps.chriscouch.net/guides/` |

## Findings

| Kind | Where | Notes |
|---|---|---|
| Cloudflare account id + D1 database id in git | `worker/wrangler.jsonc` (public repo) | Not API tokens, but infrastructure identifiers committed in a public file. |
| Demo shared-secret gate (not Access) | Pages secrets `PLA_SECRET` / `COOKIE_KEY` | Weaker than the suite's Cloudflare Access + suite user list; acceptable only while this stays a gated demo. |
| No secret values or real customer PII found in tracked files | — | Sample emails use `example` domains; RFQ / part ids are tutorial (`RFQ-1001`, `BRK-100`, etc.). |
