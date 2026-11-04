"""Build-time: classify RFQ-1002 with HermiT (via ROBOT) before and after the human fix (Incoterm DAP + A36 spec);
write public/data/reasoner-results.json. The browser replays this result next to its own live SPARQL check.
Usage: ROBOT_JAR=/path/robot.jar python tools/precompute_reasoner.py ../rfq-ontology   (needs Java 11+, rdflib)"""
import datetime, json, os, subprocess, sys, tempfile
from pathlib import Path
from rdflib import RDF, Graph, URIRef
repo = Path(sys.argv[1] if len(sys.argv) > 1 else "../rfq-ontology").resolve()
jar = os.environ.get("ROBOT_JAR", "robot.jar")
fix = json.loads(Path("public/data/shacl-results.json").read_text())["fixTurtle"]
fix += ("@prefix owl: <http://www.w3.org/2002/07/owl#> .\n<https://supergus.github.io/rfq-ontology/data/rfq-1002-fix> a owl:Ontology ;"
        " owl:imports <https://supergus.github.io/rfq-ontology/rfq> .\n")  # header so OWLAPI reads the fix as object property assertions
RFQ = URIRef("https://supergus.github.io/rfq-ontology/data#RFQ-1002")
ver = subprocess.run(["java", "-jar", jar, "--version"], capture_output=True, text=True).stdout.strip()
out = {"generated": datetime.datetime.now().isoformat(timespec="seconds"), "engine": f"HermiT via {ver}", "individual": "ex:RFQ-1002"}
with tempfile.TemporaryDirectory() as td:
    fp = Path(td) / "fix.ttl"; fp.write_text(fix)
    for key, extra in [("before", []), ("after", ["-i", str(fp)])]:
        o = Path(td) / f"{key}.ttl"
        subprocess.run(["java", "-jar", jar, "merge", "--catalog", str(repo / "ontology/catalog-v001.xml"),
                        "-i", str(repo / "data/rfq-1002-incomplete.ttl"), *extra, "reason", "--reasoner", "hermit",
                        "--axiom-generators", "ClassAssertion", "--include-indirect", "true", "-o", str(o)], check=True)
        types = sorted(str(t).split("#")[-1] for t in Graph().parse(o).objects(RFQ, RDF.type) if "rfq-ontology/ns#" in str(t))
        out[key] = {"types": types, "completeRFQ": "CompleteRFQ" in types}
Path("public/data/reasoner-results.json").write_text(json.dumps(out, indent=2) + "\n")
print(json.dumps(out, indent=1))
