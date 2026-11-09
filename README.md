# pla-demo: PLA management console (v2)

**Repo map for auditors:** [REPO-GUIDE.md](REPO-GUIDE.md) — every tracked file and how pla.chriscouch.net is served.


A live management console for one **Program Lifecycle Agent (PLA)** run on a sample RFQ, built on the
tutorial OWL ontology in [supergus/pla-agents/ontology](https://github.com/supergus/pla-agents/tree/main/ontology).
Site files live in [`public/`](public/) (Cloudflare Pages output dir; Pages project name still `rfq-demo`).
The scripted console runs in the browser with vendored libraries (`public/vendor/`, no CDN). The three AI tools
optionally call Worker **`rfq-pla`** (Workflow `rfq-pla-run`, Workers AI Llama 3.3 70B, **$20/day** hard cap) through
the Pages `PLA` service binding after the **"Secret?"** gate; when the Worker is resting or unavailable the console
falls back to canned output. No customer data — sample RFQs only.

## What it shows
"Upload RFQ package" (nothing is uploaded) starts a scripted PLA run on sample RFQ-1002:

| Stage | Tool | Kind in v2 |
|---|---|---|
| intake | `parse_rfq_document` | AI, **canned** output (no model call) |
| validate | `validate_rfq` | deterministic SHACL, **live in the browser**: shacl-engine + N3.js run the real `shapes/rfq-completeness.ttl` over the real ontology + RFQ-1002 data, before and after the human fix. The tool-run JSON also carries the build-time pySHACL result (`tools/precompute.py`) and whether they agree. Falls back to that replay (badged **replayed**) only if the browser engine fails to load |
| validate | `classify_rfq` | **reasoner moment**: RFQ-1002 flips from `rfq:RFQPackage` to `rfq:CompleteRFQ` (badged **inferred**, dashed in the graph). **Live**: a SPARQL ASK in Oxigraph that mirrors the OWL definition on asserted data. **Replayed**: the HermiT result from build time (`tools/precompute_reasoner.py`, ROBOT 1.9.11), since HermiT cannot run in a browser |
| match | `match_library_part` | AI, **canned**; the PLA's `rfq:SimilarityMatch` for the RFQ line (RFQ-1002-L1 → BRK-100, score, method) is read **live** by SPARQL (CQ12) from the repo's `data/pla-run-1002.ttl` and drawn as a node; BOM-line matches with score + method |
| cost | `explode_bom`, `cost_quote` | deterministic, **live** in the browser (`public/cost.js`, a JS port of `scripts/quote.py`) |
| approve | human gate | approve / reject |
| send | `render_quote` | simulated; nothing leaves the browser |

**SPARQL panel (live):** dropdown of CQ1 to CQ12 from `queries/`, shows the query text, runs it in Oxigraph (WebAssembly)
over the loaded graph (ontology + RFQ-1001/1002 + sample PLA run + build-time `quote-results.ttl`, plus the human fix once
made), and shows a results table. CQ1 and CQ7 are lightly rewritten copies (marked in a comment) because the originals rely on
rdflib's non-standard evaluation of `FILTER NOT EXISTS` inside `UNION`; results match rdflib on the repo data.
CQ4/CQ6 read build-time quote results; CQ9 to CQ12 read the repo's sample PLA run, not the console's own run.

Console features (from v1): header with stage, status and elapsed time; pipeline strip; issues and tasks; tool-run log with
badges (deterministic / AI / live / replayed / canned), attempt, duration and raw JSON; live graph (vis-network); quote build-up
per quantity break with click-through provenance; pause/resume; failure injection (transient: 2 failures, backoff 1 s, 2 s;
persistent: 4 attempts, then "Retry failed step"); run state in localStorage so a refresh resumes; run history.

**Demo assumption:** RFQ-1002 (BRK-200) is priced as a repeat of the BRK-100 bracket (same BOM, routing, rates, breaks
100 / 1,000 / 10,000), so numbers match the repo's worked example: unit 60.86 / 58.01 / 57.72, totals 8,016.00 / 60,660.00 / 587,050.00 (DAP).
The repo data file for RFQ-1002 has a single 500 break.

## Quote demo at `/actual/`
`public/actual/` is a **frozen** static quote-demo build (fictional demo data only; no real workbooks, prices,
customers or CER numbers). It is served at https://pla.chriscouch.net/actual/ behind the same "Secret?" gate
(root `functions/_middleware.js`; `tests/actual-gated.test.mjs` checks it). The landing page links to it.
`SOURCE.txt` records the historical pin from archived `supergus/pcaq-viewer`. Do not re-run
`tools/sync-actual.sh` without an explicit go-ahead — that repo is archived, and Graph View now lives in Leaf Tender.

## Leaf Tender (separate product)
Leaf Tender is a separate ontology management project hosted at **https://leaftender.chriscouch.net**.
`/leaf-tender/` on this site **302-redirects** there (prefix stripped, query kept). There is no
`LEAF_TENDER` service binding and no proxy: old links keep working via redirect only.
The landing page pills in `public/index.html` link out to Leaf Tender.

## Data and vendored libraries
- `public/data/`: copied from the ontology tree (`ontology/` in supergus/pla-agents; content identical to former rfq-ontology `ff69572`) (ontology/*.ttl, data/*.ttl, shapes, queries/*.rq) plus
  `quote-results.ttl` (`scripts/quote.py --ttl`), `shacl-results.json` and `reasoner-results.json` (build-time replays).
- `public/vendor/`: `rdf-shacl.js` (N3.js + rdf-ext + shacl-engine, bundled with esbuild), `oxigraph/` (web.js + wasm),
  `vis-network.min.js`. Versions in `public/vendor/VERSIONS.txt`; rebuild with `cd tools/vendor && npm ci && ./build.sh`.

## Develop and test
```
cd public && python3 -m http.server 8000                       # serve locally
node tools/test-cost.mjs                                       # cost calculator matches the repo
python tools/precompute.py ../pla-agents/ontology                     # regenerate replayed SHACL results (rdflib, pyshacl)
ROBOT_JAR=robot.jar python tools/precompute_reasoner.py ../pla-agents/ontology   # regenerate replayed HermiT result (Java)
python tools/e2e.py http://127.0.0.1:8000/ shots               # headless end-to-end test (playwright)
```


## Related repositories
- [supergus/pla-agents](https://github.com/supergus/pla-agents) — PLA orchestrator and tools, plus the tutorial OWL ontology in [`ontology/`](https://github.com/supergus/pla-agents/tree/main/ontology) (vocabulary this demo loads; formerly `supergus/rfq-ontology`, now archived).
- This repo (`pla-demo`) — live management console / quote demo at https://pla.chriscouch.net.
- Leaf Tender is a separate ontology management project hosted at https://leaftender.chriscouch.net (not part of the PLA demo).

## Process
`main` is protected: changes go through a PR and need the "Grok Bot QC" status.
Merges that touch `worker/**` or `functions/**` also run `.github/workflows/deploy-worker.yml` (Worker `rfq-pla`).
See [`worker/README.md`](worker/README.md) for the API, budget cap, and bindings.
