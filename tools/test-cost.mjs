import { costQuote } from "../public/cost.js";
const exp = { 100: [60.86, 8016.00], 1000: [58.01, 60660.00], 10000: [57.72, 587050.00] };
let ok = true;
for (const b of costQuote().breaks) { const [u, t] = exp[b.quantity]; const pass = b.unitPrice === u && b.total === t; ok &&= pass;
  console.log(b.quantity, b.unitPrice, b.total.toFixed(2), pass ? "OK" : "MISMATCH"); }
process.exit(ok ? 0 : 1);
