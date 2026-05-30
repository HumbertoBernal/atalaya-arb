// Tests unitarios del motor (sin dependencias externas, deterministas).
// Ejecutar: pnpm dlx tsx scripts/test-engine.ts
import { optimalArb, detectOpportunities } from "../src/lib/arb/engine";
import { detectTriangular } from "../src/lib/arb/triangular";
import type { OrderBooks } from "../src/lib/arb/types";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}
const approx = (a: number, b: number, t = 1e-6) => Math.abs(a - b) < t;

console.log("optimalArb:");
// Sin spread: comprar a 100, vender a 100 → 0 volumen.
{
  const r = optimalArb([{ price: 100, qty: 5 }], [{ price: 100, qty: 5 }], 0, 0, 10);
  check("sin spread no ejecuta", approx(r.qty, 0));
}
// Spread positivo sin fees: ejecuta hasta agotar liquidez (min de ambos).
{
  const r = optimalArb([{ price: 100, qty: 2 }], [{ price: 110, qty: 3 }], 0, 0, 10);
  check("ejecuta min(liquidez) = 2", approx(r.qty, 2));
  check("avgBuy=100", approx(r.avgBuy, 100));
  check("avgSell=110", approx(r.avgSell, 110));
}
// Tope de riesgo: maxBtc limita el volumen.
{
  const r = optimalArb([{ price: 100, qty: 5 }], [{ price: 110, qty: 5 }], 0, 0, 1.5);
  check("respeta maxBtc=1.5", approx(r.qty, 1.5));
}
// Se detiene cuando el margen se vuelve negativo (segundo nivel no rentable).
{
  const asks = [{ price: 100, qty: 1 }, { price: 120, qty: 5 }];
  const bids = [{ price: 110, qty: 5 }];
  const r = optimalArb(asks, bids, 0, 0, 10);
  check("se detiene al nivel no rentable (qty=1)", approx(r.qty, 1));
}
// Fees matan un spread chico: 100→100.5 con 1% fee total → no ejecuta.
{
  const r = optimalArb([{ price: 100, qty: 5 }], [{ price: 100.5, qty: 5 }], 0.005, 0.005, 10);
  check("fees > spread → no ejecuta", approx(r.qty, 0));
}

console.log("detectOpportunities:");
{
  const books: OrderBooks = {
    a: { exchange: "a", bids: [{ price: 99, qty: 5 }], asks: [{ price: 100, qty: 5 }], ts: Date.now(), latencyMs: 0, ok: true },
    b: { exchange: "b", bids: [{ price: 105, qty: 5 }], asks: [{ price: 106, qty: 5 }], ts: Date.now(), latencyMs: 0, ok: true },
  };
  const opps = detectOpportunities(books, 0);
  const best = opps[0];
  check("detecta comprar en a, vender en b", best.buyEx === "a" && best.sellEx === "b");
  check("ranking por neto (descendente)", opps.every((o, i) => i === 0 || opps[i - 1].netProfit >= o.netProfit));
  check("oportunidad inversa no viable (b→a)", !opps.find((o) => o.buyEx === "b" && o.sellEx === "a")?.viable);
}

console.log("detectTriangular:");
{
  // Construido para ser ligeramente rentable sin fees.
  const books = { btcUsd: { bid: 60000, ask: 60010 }, ethUsd: { bid: 3000, ask: 3001 }, ethBtc: { bid: 0.05, ask: 0.0500 } };
  const res = detectTriangular(books, 0);
  check("devuelve 2 direcciones", res.length === 2);
  check("netBps finito", res.every((r) => Number.isFinite(r.netBps)));
  // Con fee alto (1%/leg, 3 legs ≈ 3%) ninguna debería ser viable.
  const withFee = detectTriangular(books, 0.01);
  check("fees altos → ninguna viable", withFee.every((r) => !r.viable));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
