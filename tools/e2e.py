"""Headless end-to-end test. Usage: python tools/e2e.py URL [shotdir]"""
import sys, json, re
from playwright.sync_api import sync_playwright
RESTING = "The demo is resting for today. Please try again tomorrow."
OUT = {"parse_rfq_document": {"rfq_id": "RFQ-1003", "revision": "A", "customer": "Northwind Agricultural Equipment", "incoterm": "DAP", "delivery_date": "2027-04-01",
        "lines": [{"part": "BRK-300", "description": "welded mounting bracket", "quantities": [250, 2500]}], "low_confidence": ["incoterm"], "missing_fields": ["finish_spec"]},
       "match_library_part": {"product": "BRK-100", "matchedProduct": "ex:BRK-100", "score": 0.91, "method": "llm:llama-3.3-70b family+process", "confidence": "high", "written": True},
       "explain_quote": {"quote": "Q-1002-A", "summary": "Quote Q-1002-A: the unit price falls from $60.86 at 100 units to $57.72 at 10,000 units.", "drivers": ["Setup spread over the lot"], "breaks": [], "caveats": []}}
def mock_api(page, mode):
    """Route-intercept /api/run. mode: ok | resting | unauthorized | timeout | network"""
    runs = {}; seen = {"post": 0, "keys": []}
    def handler(route):
        req = route.request
        if mode == "network": return route.abort()
        if req.method == "POST":
            seen["post"] += 1; key = req.headers.get("idempotency-key", ""); seen["keys"].append(key)
            if mode == "resting": return route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": "resting", "message": RESTING}))
            if mode == "unauthorized": return route.fulfill(status=401, content_type="application/json", body=json.dumps({"error": "unauthorized"}))
            rid = "r-" + key; runs[rid] = json.loads(req.post_data)["tool"]
            return route.fulfill(status=202, content_type="application/json", body=json.dumps({"runId": rid}))
        rid = req.url.rsplit("/", 1)[1]; tool = runs.get(rid)
        if mode == "timeout": return route.fulfill(status=200, content_type="application/json", body=json.dumps({"runId": rid, "tool": tool, "status": "queued", "workflow": "running", "output": None, "error": None}))
        return route.fulfill(status=200, content_type="application/json", body=json.dumps({"runId": rid, "tool": tool, "status": "complete", "workflow": None, "output": OUT[tool], "error": None}))
    page.route(re.compile(r".*/api/run(/.*)?$"), handler)
    page.add_init_script("window.PLA_API_POLL_MS = 200; window.PLA_API_TIMEOUT_MS = %d;" % (2500 if mode == "timeout" else 90000))
    return seen
URL = sys.argv[1]; SH = sys.argv[2] if len(sys.argv) > 2 else "/tmp"
errs = []; results = []; external = []
def check(name, cond): results.append((name, bool(cond))); print(("PASS " if cond else "FAIL ") + name)
st = lambda p: p.evaluate("window.__pla.state && JSON.parse(JSON.stringify(window.__pla.state))")
with sync_playwright() as pw:
    b = pw.chromium.launch(); p = b.new_page(viewport={"width": 1280, "height": 1000})
    p.on("console", lambda m: m.type == "error" and errs.append(m.text)); p.on("pageerror", lambda e: errs.append(str(e)))
    host = URL.split("/")[2]
    p.on("request", lambda r: (r.url.split("/")[2] != host and not r.url.startswith("data:")) and external.append(r.url))
    api = mock_api(p, "ok")
    p.goto(URL); p.wait_for_load_state("networkidle"); p.wait_for_selector("#btn-upload:not([disabled])"); p.screenshot(path=f"{SH}/01-landing.png")
    check("knowledge base (shacl-engine + Oxigraph) loaded in browser", p.evaluate("window.__pla.kb.ready && !window.__pla.kb.error"))
    EXPECT = {1: 2, 2: 5, 3: 5, 4: 3, 5: 4, 6: 1, 7: 1, 8: 1, 9: 2, 10: 2, 11: 1, 12: 1}
    counts = p.evaluate("Object.fromEntries([...Array(12).keys()].map(i => [i+1, window.__pla.sparql(window.__pla.kb.queries[i+1].text).rows.length]))")
    check("CQ1..CQ12 row counts in browser match rdflib (%s)" % counts, {int(k): v for k, v in counts.items()} == EXPECT)
    cq12 = p.evaluate("window.__pla.sparql(window.__pla.kb.queries[12].text).rows[0]")
    check("CQ12 returns the PLA SimilarityMatch RFQ-1002-L1 -> BRK-100, 0.91", cq12[:3] == ["ex:RFQ-1002-L1", "ex:BRK-100", "0.91"])
    p.click("#btn-upload")
    p.wait_for_function("window.__pla.state && window.__pla.state.runs.length >= 1")
    rid = st(p)["runId"]; p.reload(); p.wait_for_function("window.__pla.state")
    s = st(p); check("refresh mid-run resumes same run", s["runId"] == rid and not p.is_hidden("#banner"))
    p.screenshot(path=f"{SH}/02-resumed-after-refresh.png")
    p.wait_for_function("window.__pla.state.status === 'blocked'", timeout=20000)
    s = st(p); msgs = [i["title"] for i in s["issues"] if i["owner"] == "human" and not i["resolved"]]
    check("SHACL raises exactly Incoterm + material spec", sorted(msgs) == ["MISSING Incoterm", "MISSING material or finish spec"])
    v1 = [r for r in s["runs"] if r["tool"] == "validate_rfq" and r["ok"]][0]
    check("first SHACL run is live in browser and agrees with build-time pySHACL", "live" in v1["output"]["engine"] and not v1["replay"] and v1["output"]["buildTimePySHACL"]["agrees"])
    p.select_option("#cq-sel", "1"); p.click("#cq-run"); p.wait_for_selector("#cq-out table")
    check("SPARQL panel CQ1 before fix shows 2 rows", p.locator("#cq-out table tr").count() == 3)
    p.locator(".panel.sparql").scroll_into_view_if_needed(); p.screenshot(path=f"{SH}/03b-sparql-cq1-before-fix.png", full_page=True)
    p.screenshot(path=f"{SH}/03-blocked-shacl-issues.png", full_page=True)
    p.check("#tog-fail")  # transient failure armed for next tool call
    p.click("[data-fix='SH-HasIncoterm']"); p.click("[data-fix='SH-HasMaterialOrFinishSpec']")
    p.wait_for_function("window.__pla.state.runs.some(r => !r.ok)", timeout=20000)
    p.screenshot(path=f"{SH}/04-retrying-after-injected-failure.png", full_page=True)
    p.wait_for_function("window.__pla.state.status === 'awaiting'", timeout=60000)
    s = st(p); fails = [r for r in s["runs"] if not r["ok"]]
    check("injected failure retried with backoff 1s,2s and recovered", len(fails) == 2 and [f.get("nextRetryInMs") for f in fails] == [1000, 2000])
    check("failure issue logged and resolved", any(i["id"].startswith("FAIL-") and i["resolved"] for i in s["issues"]))
    v = [r for r in s["runs"] if r["tool"] == "validate_rfq" and r["ok"]]
    check("SHACL re-run passes", v[-1]["output"]["conforms"] is True)
    check("SHACL re-run is live and agrees with pySHACL", "live" in v[-1]["output"]["engine"] and v[-1]["output"]["buildTimePySHACL"]["agrees"])
    c = [r for r in s["runs"] if r["tool"] == "classify_rfq" and r["ok"]]
    check("reasoner moment: live ASK infers CompleteRFQ; HermiT replay agrees", c and c[-1]["output"]["inferredType"] == "rfq:CompleteRFQ" and c[-1]["output"]["liveCheck"]["result"] is True and "CompleteRFQ" in c[-1]["output"]["hermit"]["after"] and "CompleteRFQ" not in c[-1]["output"]["hermit"]["before"])
    check("reasoner state before run was not CompleteRFQ", s.get("reasonerBefore") is False)
    check("graph shows inferred CompleteRFQ type", any(n["id"] == "CLS-Complete" for n in s["nodes"]) and "inferred" in p.inner_text("#reasoner").lower())
    sm = [n for n in s["nodes"] if n["id"] == "SM-1002-L1"]
    check("graph shows PLA SimilarityMatch node with score and method", sm and "0.91" in sm[0]["label"] and "llama" in sm[0]["label"])
    p.select_option("#cq-sel", "1"); p.click("#cq-run"); p.wait_for_selector("#cq-out p")
    check("SPARQL CQ1 after fix returns no rows (live graph includes fix)", "No rows" in p.inner_text("#cq-out"))
    p.select_option("#cq-sel", "12"); p.click("#cq-run"); p.wait_for_selector("#cq-out table")
    p.locator(".panel.sparql").scroll_into_view_if_needed(); p.screenshot(path=f"{SH}/05b-sparql-cq12-reasoner.png", full_page=True)
    p.evaluate("window.scrollTo(0,0)"); p.wait_for_timeout(1500)
    p.locator("#graph").screenshot(path=f"{SH}/05c-graph-overview.png")
    p.evaluate("window.__pla.net.fit({nodes: ['RFQ-1002','CLS-Complete','L1','SM-1002-L1','BRK-100'], animation: false})"); p.wait_for_timeout(500)
    p.locator("#graph").screenshot(path=f"{SH}/05d-graph-similaritymatch-inferred-zoom.png")
    q = {b["quantity"]: (b["unitPrice"], b["total"]) for b in s["quote"]["breaks"]}
    check("quote numbers match repo", q == {100: (60.86, 8016.0), 1000: (58.01, 60660.0), 10000: (57.72, 587050.0)})
    p.click("td[data-pv='unitPrice:1']"); p.wait_for_selector("#drawer:not([hidden])")
    check("provenance drawer shows source", "FY2026" in p.inner_text("#drawer") or "Margin source" in p.inner_text("#drawer"))
    p.screenshot(path=f"{SH}/05-approval-gate-provenance.png", full_page=True); p.click("#drawer-x")
    p.reload(); p.wait_for_function("window.__pla.state"); check("refresh at gate keeps awaiting", st(p)["status"] == "awaiting")
    ai = {r["tool"]: r for r in s["runs"] if r["ok"] and r["tool"] in OUT}
    check("mocked API: all three AI tools ran live (parse, match, explain)", all(t in ai and ai[t].get("live") and not ai[t].get("fallback") for t in OUT))
    check("live parse output (RFQ-1003, quantities 250/2500) recorded in run log", ai["parse_rfq_document"]["output"]["liveParse"]["lines"][0]["quantities"] == [250, 2500])
    check("Idempotency-Key stable per run+step (one POST per tool, despite reload)", sorted(set(api["keys"])) == sorted(f"{s['runId']}-{t}" for t in OUT))
    check("console badges 'live · Llama 3.3 70B'", p.locator("#log .b.live", has_text="Llama 3.3 70B").count() >= 3)
    check("explanation shown under quote (live)", "60.86" in p.inner_text("#explain") and "llama" in p.inner_text("#explain").lower())
    p.locator("#explain").scroll_into_view_if_needed(); p.screenshot(path=f"{SH}/05e-live-explain-quote.png", full_page=True)
    p.click("#btn-approve"); p.wait_for_function("window.__pla.state.status === 'sent'", timeout=20000)
    check("approve -> sent (simulated)", True); p.screenshot(path=f"{SH}/06-sent.png", full_page=True)
    # persistent failure path
    p.click("#btn-new"); p.wait_for_selector("#btn-upload:not([disabled])"); p.click("#btn-upload"); p.select_option("#fail-mode", "persistent"); p.check("#tog-fail")
    p.wait_for_function("window.__pla.state.status === 'failed'", timeout=60000)
    s = st(p); check("persistent failure exhausts 4 attempts -> failed", sum(1 for r in s["runs"] if not r["ok"]) == 4)
    p.screenshot(path=f"{SH}/07-failed-exhausted.png", full_page=True)
    p.click("#btn-retry"); p.wait_for_function("window.__pla.state.status === 'blocked'", timeout=20000)
    check("manual retry continues the run", True)
    check("run history lists runs", p.locator("#history .hist").count() >= 2)
    p.click("#btn-about"); p.screenshot(path=f"{SH}/08-about.png")
    b.close()
    # ---------- fallback scenarios (mocked /api) ----------
    for mode, reason in [("resting", "resting"), ("unauthorized", "unauthorized"), ("timeout", "timeout"), ("network", "network")]:
        b = pw.chromium.launch(); q = b.new_page(viewport={"width": 1280, "height": 1000}); mock_api(q, mode)
        q.goto(URL); q.wait_for_selector("#btn-upload:not([disabled])"); q.click("#btn-upload")
        q.wait_for_function("window.__pla.state && window.__pla.state.status === 'blocked'", timeout=30000)
        s = st(q); r = [x for x in s["runs"] if x["tool"] == "parse_rfq_document"][-1]
        check(f"{mode}: parse step fell back to scripted output (reason {reason}) and run continued", r["ok"] and r.get("fallback", {}).get("reason") == reason and not r.get("live") and s["status"] == "blocked")
        check(f"{mode}: badge 'scripted (fallback)' shown", q.locator("#log .b.canned", has_text="scripted (fallback)").count() >= 1)
        if mode == "resting": check("503 message shown verbatim in UI", RESTING in q.inner_text("#api-notice") and RESTING in q.inner_text("#issues"))
        if mode == "unauthorized": check("401 tells user to reload and re-enter secret", "enter the secret again" in q.inner_text("#api-notice"))
        q.screenshot(path=f"{SH}/09-fallback-{mode}.png", full_page=True); b.close()
    # ---------- past runs: reopen an awaiting run from history, approve it, view a sent run read-only ----------
    b = pw.chromium.launch(); q = b.new_page(viewport={"width": 1280, "height": 1000}); api2 = mock_api(q, "ok")
    q.on("console", lambda m: m.type == "error" and errs.append(m.text)); q.on("pageerror", lambda e: errs.append(str(e)))
    q.goto(URL); q.wait_for_selector("#btn-upload:not([disabled])"); q.click("#btn-upload")
    q.wait_for_function("window.__pla.state.status === 'blocked'", timeout=30000)
    q.click("[data-fix='SH-HasIncoterm']"); q.click("[data-fix='SH-HasMaterialOrFinishSpec']")
    q.wait_for_function("window.__pla.state.status === 'awaiting'", timeout=60000)
    rid = st(q)["runId"]; posts = api2["post"]
    q.reload(); q.wait_for_function("window.__pla.state"); q.click("#btn-new"); q.wait_for_selector("#landing:not([hidden])")
    row = q.locator(f"#landing-history [data-run='{rid}']")
    check("landing past runs lists the awaiting run as clickable", row.count() == 1 and "awaiting" in row.inner_text() and row.get_attribute("tabindex") == "0")
    q.screenshot(path=f"{SH}/10-landing-past-runs.png", full_page=True)
    row.click(); q.wait_for_selector("#btn-approve")
    s2 = st(q)
    check("reopened awaiting run restores log, issues, graph, quote and gate", s2["runId"] == rid and s2["status"] == "awaiting" and len(s2["runs"]) >= 8 and s2["quote"] and q.locator("#log details").count() == len(s2["runs"]) and q.locator("#quote table").count() == 1 and q.locator("#btn-approve").count() == 1 and q.locator("#btn-reject").count() == 1)
    q.screenshot(path=f"{SH}/11-reopened-awaiting-gate.png", full_page=True)
    q.click("#btn-approve"); q.wait_for_function("window.__pla.state.status === 'sent'", timeout=20000)
    check("restore + approve made no new /api calls (no duplicate Idempotency-Key runs)", api2["post"] == posts and len(api2["keys"]) == len(set(api2["keys"])))
    q.click("#btn-new"); q.wait_for_selector("#landing:not([hidden])")
    row = q.locator(f"#landing-history [data-run='{rid}']")
    check("past runs list now shows the run as sent", "sent" in row.inner_text())
    row.focus(); q.keyboard.press("Enter"); q.wait_for_selector("#console:not([hidden])")
    check("sent run opens read-only via keyboard (approval recorded, no gate buttons)", st(q)["status"] == "sent" and "Read-only" in q.inner_text("#banner") and q.locator("#btn-approve").count() == 0 and "approved" in q.inner_text("#gate"))
    q.screenshot(path=f"{SH}/12-sent-run-read-only.png", full_page=True)
    q.evaluate("""() => { const h = JSON.parse(localStorage.getItem('rfqdemo.history.v1')); h.push({runId: 'RUN-LEGACY-x', startedAt: Date.now(), status: 'awaiting', totals: null}); localStorage.setItem('rfqdemo.history.v1', JSON.stringify(h)); }""")
    q.click("#btn-new"); q.wait_for_selector("#landing:not([hidden])"); q.click("[data-abandon='RUN-LEGACY-x']")
    check("legacy awaiting run without saved details can be abandoned", "abandoned" in q.locator("#landing-history [data-run='RUN-LEGACY-x']").inner_text())
    b.close()
check("no console errors", not errs); print("console errors:", errs)
check("no requests to other hosts (libraries vendored)", not external); print("external requests:", external)
print(json.dumps({"passed": sum(r for _, r in results), "total": len(results)}))
sys.exit(0 if all(r for _, r in results) else 1)
