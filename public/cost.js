// Deterministic cost calculator: a JS port of rfq-ontology/scripts/quote.py.
// Inputs mirror rfq-ontology data/reference.ttl + data/rfq-1001.ttl (see docs/worked-example.md).
export const MODEL = {
  product: "BRK-100 welded mounting bracket (category: Structural brackets)",
  quoteDate: "2026-10-27",
  bom: [
    { id: "BL-1", component: "Base plate", make: true, qtyPer: 1, scrap: 0.05, entry: "PLT-210", score: 0.92, method: "attribute-weighted v1", confidence: "high", unitCost: 4.00,
      routing: [{ op: "10 laser cut", wc: "WC-LASER", setup: 0.50, run: 0.05 }, { op: "20 bend", wc: "WC-BRAKE", setup: 0.75, run: 0.04 }, { op: "30 weld gussets", wc: "WC-WELD", setup: 0.50, run: 0.15 }] },
    { id: "BL-2", component: "Gusset", make: true, qtyPer: 2, scrap: 0.05, entry: "GUS-033", score: 0.88, method: "attribute-weighted v1", confidence: "high", unitCost: 1.50,
      routing: [{ op: "10 laser cut", wc: "WC-LASER", setup: 0.25, run: 0.02 }] },
    { id: "BL-3", component: "Hex bolt M8 x 25", make: false, qtyPer: 4, scrap: 0.02, entry: "BLT-M8x25", score: 0.99, method: "part-number exact", confidence: "high", unitCost: 0.12 },
    { id: "BL-4", component: "Bushing 12 mm", make: false, qtyPer: 2, scrap: 0.0, entry: "BSH-12", score: 0.71, method: "attribute-weighted v1", confidence: "medium", unitCost: 0.85 },
    { id: "BL-5", component: "Serial number label", make: false, qtyPer: 1, scrap: 0.10, entry: null, score: null, method: "manual override", confidence: "low", unitCost: 0.25, override: true },
  ],
  workCenters: {
    "WC-LASER": { labor: 45, machine: 60, burden: 15, effective: "2026-01-01", source: "FY2026 standard cost study" },
    "WC-BRAKE": { labor: 40, machine: 35, burden: 15, effective: "2026-01-01", source: "FY2026 standard cost study" },
    "WC-WELD":  { labor: 42, machine: 18, burden: 15, effective: "2026-01-01", source: "FY2026 standard cost study (supersedes FY2025 row at 70/h)" },
  },
  overhead: { value: 0.12, effective: "2026-01-01", source: "FY2026 overhead rate" },
  sga: { value: 0.10, effective: "2026-01-01", source: "FY2026 SG&A rate" },
  margin: { value: 0.25, effective: "2026-01-01", source: "Target margin on price, Structural brackets" },
  freight: { perUnit: 0.80, effective: "2026-01-01", source: "Freight rate table (seller pays under DAP)" },
  nre: [{ label: "Weld fixture", amount: 1500 }, { label: "First-article inspection", amount: 350 }],
  breaks: [100, 1000, 10000],
};

const rate = (wc) => wc.labor + wc.machine + wc.burden;
const cents = (x) => Math.round((x + 1e-9) * 100) / 100; // half-up to the cent (inputs positive)

export function costQuote(m = MODEL, incoterm = "DAP") {
  let material = 0, setup = 0, run = 0;
  const matLines = [], convLines = [];
  for (const bl of m.bom) {
    const amt = bl.qtyPer * bl.unitCost * (1 + bl.scrap);
    material += amt;
    matLines.push({ line: bl.id, formula: `${bl.qtyPer} × ${bl.unitCost.toFixed(2)} × ${(1 + bl.scrap).toFixed(2)}`, amount: amt, source: bl.override ? "manual override (low confidence)" : `library ${bl.entry}` });
    for (const st of bl.routing || []) {
      const r = rate(m.workCenters[st.wc]);
      setup += st.setup * r; run += st.run * bl.qtyPer * r;
      convLines.push({ line: bl.id, op: st.op, wc: st.wc, rate: r, setupCost: st.setup * r, runCost: st.run * bl.qtyPer * r, ...m.workCenters[st.wc] });
    }
  }
  const sellerPays = incoterm === "DAP" || incoterm === "DDP";
  const nre = m.nre.reduce((a, n) => a + n.amount, 0);
  const breaks = m.breaks.map((q) => {
    const conversion = setup / q + run;
    const cogs = material + conversion;
    const overhead = cogs * m.overhead.value, sga = cogs * m.sga.value;
    const loaded = cogs + overhead + sga;
    const unitPrice = cents(loaded / (1 - m.margin.value));
    const extended = cents(unitPrice * q);
    const freight = sellerPays ? cents(m.freight.perUnit * q) : 0;
    const total = cents(extended + nre + freight);
    return { quantity: q, material, conversion, cogs, overhead, sga, loaded, unitPrice, extended, nre, freight, total };
  });
  return { breaks, material, setupPerLot: setup, runPerUnit: run, matLines, convLines, incoterm, sellerPays };
}
