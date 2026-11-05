"""Build-time: run pySHACL on RFQ-1002 before and after the human fixes; write data/shacl-results.json.
Usage: python tools/precompute.py ../pla-agents/ontology"""
import json, sys, glob, datetime
from pathlib import Path
from rdflib import Graph
from pyshacl import validate
repo = Path(sys.argv[1] if len(sys.argv) > 1 else "../pla-agents/ontology")
FIX = """@prefix rfq: <https://supergus.github.io/rfq-ontology/ns#> .
@prefix ex: <https://supergus.github.io/rfq-ontology/data#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:RFQ-1002-DT rfq:hasIncoterm rfq:DAP .
ex:RFQ-1002 rfq:hasTechnicalRequirement ex:SPEC-1002-A36 .
ex:SPEC-1002-A36 a rfq:MaterialSpec ; rdfs:label "ASTM A36 steel plate" .
"""
def load(extra=None):
    g = Graph()
    for f in sorted(glob.glob(str(repo/"ontology/*.ttl"))): g.parse(f)
    g.parse(repo/"data/reference.ttl"); g.parse(repo/"data/rfq-1002-incomplete.ttl")
    if extra: g.parse(data=extra, format="turtle")
    return g
shapes = Graph().parse(repo/"shapes/rfq-completeness.ttl")
out = {"generated": datetime.datetime.now().isoformat(timespec="seconds"), "engine": "pySHACL", "fixTurtle": FIX}
for key, extra in [("before", None), ("after", FIX)]:
    conforms, rg, _ = validate(load(extra), shacl_graph=shapes, inference="rdfs")
    q = """PREFIX sh: <http://www.w3.org/ns/shacl#>
    SELECT ?focus ?msg ?shape WHERE { ?r a sh:ValidationResult ; sh:focusNode ?focus ; sh:resultMessage ?msg ; sh:sourceShape ?shape }"""
    res = [{"focus": str(r.focus).split("#")[-1], "message": str(r.msg), "shape": str(r.shape).split("#")[-1]} for r in rg.query(q)]
    out[key] = {"conforms": bool(conforms), "results": sorted(res, key=lambda x: x["message"])}
Path("public/data/shacl-results.json").write_text(json.dumps(out, indent=2))
print(json.dumps(out, indent=1))
