"""Headless end-to-end test. Usage: python tools/e2e.py URL [shotdir]"""
import sys, json
from playwright.sync_api import sync_playwright
URL = sys.argv[1]; SH = sys.argv[2] if len(sys.argv) > 2 else "/tmp"
errs = []; results = []; external = []
def check(name, cond): results.append((name, bool(cond))); print(("PASS " if cond else "FAIL ") + name)
st = lambda p: p.evaluate("window.__pla.state && JSON.parse(JSON.stringify(window.__pla.state))")
with sync_playwright() as pw:
    b = pw.chromium.launch(); p = b.new_page(viewport={"width": 1280, "height": 1000})
    p.on("console", lambda m: m.type == "error" and errs.append(m.text)); p.on("pageerror", lambda e: errs.append(str(e)))
    host = URL.split("/")[2]
    p.on("request", lambda r: (r.url.split("/")[2] != host and not r.url.startswith("data:")) and external.append(r.url))
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
check("no console errors", not errs); print("console errors:", errs)
check("no requests to other hosts (libraries vendored)", not external); print("external requests:", external)
print(json.dumps({"passed": sum(r for _, r in results), "total": len(results)}))
sys.exit(0 if all(r for _, r in results) else 1)
