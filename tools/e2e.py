"""Headless end-to-end test. Usage: python tools/e2e.py URL [shotdir]"""
import sys, json
from playwright.sync_api import sync_playwright
URL = sys.argv[1]; SH = sys.argv[2] if len(sys.argv) > 2 else "/tmp"
errs = []; results = []
def check(name, cond): results.append((name, bool(cond))); print(("PASS " if cond else "FAIL ") + name)
st = lambda p: p.evaluate("window.__pla.state && JSON.parse(JSON.stringify(window.__pla.state))")
with sync_playwright() as pw:
    b = pw.chromium.launch(); p = b.new_page(viewport={"width": 1280, "height": 1000})
    p.on("console", lambda m: m.type == "error" and errs.append(m.text)); p.on("pageerror", lambda e: errs.append(str(e)))
    p.goto(URL); p.wait_for_load_state("networkidle"); p.wait_for_selector("#btn-upload:not([disabled])"); p.screenshot(path=f"{SH}/01-landing.png")
    p.click("#btn-upload")
    p.wait_for_function("window.__pla.state && window.__pla.state.runs.length >= 1")
    rid = st(p)["runId"]; p.reload(); p.wait_for_function("window.__pla.state")
    s = st(p); check("refresh mid-run resumes same run", s["runId"] == rid and not p.is_hidden("#banner"))
    p.screenshot(path=f"{SH}/02-resumed-after-refresh.png")
    p.wait_for_function("window.__pla.state.status === 'blocked'", timeout=20000)
    s = st(p); msgs = [i["title"] for i in s["issues"] if i["owner"] == "human" and not i["resolved"]]
    check("SHACL raises exactly Incoterm + material spec", sorted(msgs) == ["MISSING Incoterm", "MISSING material or finish spec"])
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
print(json.dumps({"passed": sum(r for _, r in results), "total": len(results)}))
sys.exit(0 if all(r for _, r in results) else 1)
