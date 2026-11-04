# rfq-demo: PLA management console (v1)

A live management console for one **Program Lifecycle Agent (PLA)** run on a sample RFQ, built on the
[supergus/rfq-ontology](https://github.com/supergus/rfq-ontology) OWL ontology.
Static site, no backend, no secrets, no API keys. Site files live in [`public/`](public/) (Cloudflare Pages output dir).

## What it shows
"Upload RFQ package" (nothing is uploaded) starts a scripted PLA run on sample RFQ-1002:

| Stage | Tool | Kind in v1 |
|---|---|---|
| intake | `parse_rfq_document` | AI, **canned** output (no model call) |
| validate | `validate_rfq` | deterministic SHACL, **replayed**: real pySHACL results computed at build time (`tools/precompute.py`) for RFQ-1002 before and after the human fixes |
| match | `match_library_part` | AI, **canned**; similarity matches with score + method |
| cost | `explode_bom`, `cost_quote` | deterministic, **live** in the browser (`public/cost.js`, a JS port of `scripts/quote.py`) |
| approve | human gate | approve / reject |
| send | `render_quote` | simulated; nothing leaves the browser |

Console features: header with stage, status and elapsed time; pipeline strip; issues and tasks (human issues resolve the
missing Incoterm and material spec, then SHACL re-runs and passes); tool-run log with badges, attempt, duration and raw JSON;
live graph (vis-network); quote build-up per quantity break with click-through provenance; pause/resume; failure injection
(transient: 2 failures, exponential backoff 1 s, 2 s; persistent: 4 attempts exhausted, then "Retry failed step");
run state saved to localStorage after every step so a refresh resumes; run history.

**Demo assumption:** RFQ-1002 (BRK-200) is priced as a repeat of the BRK-100 bracket (same BOM, routing, rates, breaks
100 / 1,000 / 10,000), so numbers match the repo's worked example: unit 60.86 / 58.01 / 57.72, totals 8,016.00 / 60,660.00 / 587,050.00 (DAP).
The repo data file for RFQ-1002 has a single 500 break.

## Develop and test
```
cd public && python3 -m http.server 8000           # serve locally
node tools/test-cost.mjs                           # cost calculator matches the repo
python tools/precompute.py ../rfq-ontology         # regenerate SHACL results (needs rdflib, pyshacl)
python tools/e2e.py http://127.0.0.1:8000/ shots   # headless end-to-end test (playwright)
```

## Process
`main` is protected: changes go through a PR and need the "Grok Bot QC" status.
