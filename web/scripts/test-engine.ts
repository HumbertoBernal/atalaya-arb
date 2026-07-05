// Tests unitarios del motor (sin dependencias externas, deterministas).
// Ejecutar: pnpm dlx tsx scripts/test-engine.ts
import {
  abortedTrade,
  detectOpportunities,
  evalPair,
  optimalArb,
  recheckOpportunity,
  simulateExecution,
  totalEquity,
} from "../src/lib/arb/engine";
import { detectTriangular } from "../src/lib/arb/triangular";
import { overlayWs, isL2Valid, referencePrice, percentile } from "../src/lib/arb/mergeBooks";
import { zScore, pushCapped } from "../src/lib/arb/stats";
import {
  creditTransfer,
  debitTransfers,
  needsRebalance,
  planRebalance,
  projectWallets,
} from "../src/lib/arb/rebalance";
import { applyChaos, chaosActive, NO_CHAOS } from "../src/lib/arb/chaos";
import { evaluateRisk } from "../src/lib/arb/risk";
import { freshDefaults, type EngineParams } from "../src/lib/arb/params";
import type { OrderBook, OrderBooks, Wallet } from "../src/lib/arb/types";

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

// Params de test: sin fees (feeMult 0) y sin umbral, igual que la suite previa.
const P = (over: Partial<EngineParams> = {}): EngineParams => ({
  ...freshDefaults(),
  feeMult: 0,
  minNetBps: 0,
  ...over,
});

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

const book = (ex: string, bid: number, ask: number, ts = Date.now()): OrderBook => ({
  exchange: ex, bids: [{ price: bid, qty: 5 }], asks: [{ price: ask, qty: 5 }], ts, latencyMs: 0, ok: true,
});

console.log("detectOpportunities:");
{
  const books: OrderBooks = {
    a: book("a", 99, 100),
    b: book("b", 105, 106),
  };
  const opps = detectOpportunities(books, P());
  const best = opps[0];
  check("detecta comprar en a, vender en b", best.buyEx === "a" && best.sellEx === "b");
  check("ranking por neto (descendente)", opps.every((o, i) => i === 0 || opps[i - 1].netProfit >= o.netProfit));
  check("oportunidad inversa no viable (b→a)", !opps.find((o) => o.buyEx === "b" && o.sellEx === "a")?.viable);
}

console.log("parametrización:");
{
  const books: OrderBooks = { a: book("a", 99, 100), b: book("b", 105, 106) };
  // Umbral en bps: el spread a→b es ~500 bps neto (sin fees). Umbral mayor lo descarta.
  const low = detectOpportunities(books, P({ minNetBps: 100 }));
  check("umbral 100 bps: sigue viable", low.find((o) => o.buyEx === "a")!.viable);
  const high = detectOpportunities(books, P({ minNetBps: 2000 }));
  check("umbral 2000 bps: deja de ser viable", !high.find((o) => o.buyEx === "a")?.viable);
  // Exchange desactivado: desaparece del universo de detección.
  const off = detectOpportunities(books, P({ activeExchanges: { a: true, b: false } }));
  check("venue desactivado no participa", off.length === 0);
  // maxTradeBtc configurable limita el volumen detectado.
  const small = detectOpportunities(books, P({ maxTradeBtc: 0.3 }));
  check("maxTradeBtc=0.3 limita qty", approx(small[0].maxQty, 0.3));
  // Fees editables por venue: un fee altísimo mata la viabilidad.
  const fat = detectOpportunities(
    books,
    P({ feeMult: 1, takerFee: { a: 0.05, b: 0.05 } }),
  );
  check("fee editado 5%+5% mata el neto", !fat.find((o) => o.buyEx === "a")?.viable);
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

console.log("mergeBooks / helpers:");
{
  check("percentile vacío = 0", percentile([], 50) === 0);
  check("percentile p50", percentile([1, 2, 3, 4], 50) === 3);
  check("referencePrice = mid del primer ok", referencePrice([book("a", 100, 102)]) === 101);
  check("referencePrice sin libros = 0", referencePrice([]) === 0);
  // overlayWs: top más fresco reemplaza el nivel 0 si mantiene monotonicidad.
  const b = book("a", 100, 101, 1000);
  const o = overlayWs(b, { bid: 100.5, ask: 100.8, ts: 2000 });
  check("overlayWs aplica top fresco", o.bids[0].price === 100.5 && o.asks[0].price === 100.8);
  const stale = overlayWs(b, { bid: 100.5, ask: 100.8, ts: 500 });
  check("overlayWs ignora top viejo", stale.bids[0].price === 100);
  check("isL2Valid: libro válido y fresco", isL2Valid(book("a", 100, 101, Date.now()), Date.now()));
  check("isL2Valid: libro cruzado → false", !isL2Valid(book("a", 101, 100, Date.now()), Date.now()));
}

console.log("stats:");
{
  check("zScore n<2 → z=0", zScore([5]).z === 0);
  const z = zScore([1, 2, 3, 4, 10]);
  check("zScore último valor alto → z>0", z.z > 0);
  check("pushCapped respeta el tope", pushCapped([1, 2, 3], 4, 3).length === 3);
  check("pushCapped descarta el más viejo", pushCapped([1, 2, 3], 4, 3)[0] === 2);
}

console.log("rebalance dirigido:");
{
  const cfg = { minUsd: 5000, minBtc: 0.1, btcNetworkFee: 0.0003, transferDelaySec: 0 };
  const wallets: Record<string, Wallet> = {
    a: { exchange: "a", usd: 0, btc: 4 },
    b: { exchange: "b", usd: 100000, btc: 0 },
  };
  check("needsRebalance detecta agotamiento", needsRebalance(wallets, cfg));
  const { transfers, costUsd } = planRebalance(wallets, 50000, cfg, 1000);
  check("planifica 2 transferencias dirigidas (usd b→a, btc a→b)", transfers.length === 2);
  const usdT = transfers.find((t) => t.asset === "usd")!;
  const btcT = transfers.find((t) => t.asset === "btc")!;
  check("USD viaja del sobrado al agotado", usdT.from === "b" && usdT.to === "a");
  check("BTC viaja del sobrado al agotado", btcT.from === "a" && btcT.to === "b");
  check("costo = fee de red valuado", approx(costUsd, 0.0003 * 50000));

  // Liquidación completa: débito inmediato + crédito al confirmar.
  let w = debitTransfers(wallets, transfers);
  check("débito inmediato: el BTC sale del origen", w.a.btc < 4);
  const inTransit = projectWallets(w, transfers);
  check("proyección con fondos en tránsito ya no dispara rebalanceo", !needsRebalance(inTransit, cfg));
  for (const t of transfers) w = creditTransfer(w, t);
  const totalBtc = Object.values(w).reduce((s, x) => s + x.btc, 0);
  check("BTC total se conserva menos el fee de red", approx(totalBtc, 4 - 0.0003));
  check("ambos venues quedan sobre el mínimo", !needsRebalance(w, cfg));

  // Sin déficit no se planifica nada.
  const sane: Record<string, Wallet> = {
    a: { exchange: "a", usd: 50000, btc: 2 },
    b: { exchange: "b", usd: 50000, btc: 2 },
  };
  check("sin déficit → 0 transferencias", planRebalance(sane, 50000, cfg, 0).transfers.length === 0);

  // Regresión A1: capital ya en tránsito hacia un venue no se vuelve a enviar.
  // `a` sigue agotado en saldos reales, pero los proyectados (real + en camino)
  // ya lo sanean → el plan no debe duplicar la transferencia hacia `a`.
  const enTransito: Record<string, Wallet> = {
    a: { exchange: "a", usd: 1000, btc: 2 },
    b: { exchange: "b", usd: 50000, btc: 2 },
    c: { exchange: "c", usd: 48000, btc: 2 },
  };
  const proyectado: Record<string, Wallet> = {
    ...enTransito,
    a: { exchange: "a", usd: 34000, btc: 2 }, // 33k USD vienen en camino
  };
  const dupe = planRebalance(enTransito, 50000, cfg, 0, { projected: proyectado });
  check("A1: no duplica envíos a venue con fondos en tránsito", dupe.transfers.length === 0);

  // M4: un venue que no puede recibir (desactivado) dona pero no se fondea.
  const conInactivo: Record<string, Wallet> = {
    a: { exchange: "a", usd: 1000, btc: 2 },
    b: { exchange: "b", usd: 99000, btc: 2 },
  };
  const sinReceptor = planRebalance(conInactivo, 50000, cfg, 0, { canReceive: (ex) => ex !== "a" });
  check("M4: venue no-receptor no recibe transferencias", !sinReceptor.transfers.some((t) => t.to === "a"));
  const normal = planRebalance(conInactivo, 50000, cfg, 0);
  check("M4: sin restricción sí lo fondea", normal.transfers.some((t) => t.to === "a"));
}

console.log("simulateExecution:");
{
  const books: OrderBooks = { a: book("a", 99, 100), b: book("b", 110, 111) };
  const wallets: Record<string, Wallet> = {
    a: { exchange: "a", usd: 100000, btc: 5 },
    b: { exchange: "b", usd: 100000, btc: 5 },
  };
  const opps = detectOpportunities(books, P());
  const viable = opps.find((o) => o.viable)!;
  const { trade, wallets: next } = simulateExecution(viable, books, wallets, P());
  check("simulateExecution genera trade neto-positivo", !!trade && trade.netProfit > 0);
  check("trade lleva status filled", trade?.status === "filled");
  if (trade) {
    const btcBefore = 10;
    const btcAfter = next.a.btc + next.b.btc;
    check("conserva BTC total (arb compra=vende)", Math.abs(btcAfter - btcBefore) < 1e-6);
    check("USD total sube por el neto", next.a.usd + next.b.usd > 200000);
  }
  // Sin saldo BTC en el venue de venta → no ejecuta.
  const noBtc = { a: wallets.a, b: { exchange: "b", usd: 100000, btc: 0 } };
  check("sin BTC en sellEx → no ejecuta", simulateExecution(viable, books, noBtc, P()).trade === null);
  // Modo maker: el fill esperado se escala por la probabilidad configurada.
  const taker = simulateExecution(viable, books, wallets, P()).trade!;
  const maker = simulateExecution(viable, books, wallets, P({ maker: true, makerFillProb: 0.5 })).trade!;
  check("maker fill prob 0.5 → mitad del volumen", approx(maker.qty, taker.qty * 0.5, 1e-6));
}

console.log("re-verificación (dos fases):");
{
  const books: OrderBooks = { a: book("a", 99, 100), b: book("b", 110, 111) };
  const expected = evalPair("a", "b", books, P())!;
  // Mercado quieto → la orden pasa.
  const still = recheckOpportunity(expected, books, P());
  check("sin deriva → ok", still.ok && approx(still.driftBps, 0, 0.01));
  // El spread se cerró por completo → aborta.
  const closed: OrderBooks = { a: book("a", 99, 100), b: book("b", 99, 100) };
  const dead = recheckOpportunity(expected, closed, P());
  check("spread cerrado → aborta", !dead.ok);
  // Deriva moderada: neto cae ~10 bps. Tolerancia 5 → aborta; 50 → pasa.
  const drifted: OrderBooks = { a: book("a", 99, 100), b: book("b", 109.9, 111) };
  const tight = recheckOpportunity(expected, drifted, P({ recheckTolBps: 5 }));
  check("deriva > tolerancia → aborta", !tight.ok && tight.driftBps > 5);
  const loose = recheckOpportunity(expected, drifted, P({ recheckTolBps: 50 }));
  check("deriva < tolerancia → ejecuta", loose.ok);
  // La entrada de ledger del aborto es neutra en P&L.
  const ab = abortedTrade(expected, "test", 10);
  check("abortedTrade: qty 0 y neto 0", ab.qty === 0 && ab.netProfit === 0 && ab.status === "aborted");
}

console.log("modo caos:");
{
  const books = [book("a", 99, 100), book("b", 110, 111)];
  check("NO_CHAOS no está activo", !chaosActive(NO_CHAOS, Date.now()));
  const dead = applyChaos(books, { ...NO_CHAOS, offline: { a: true } }, Date.now());
  check("venue caído queda offline", !dead.map.a.ok && dead.map.b.ok);
  const dry = applyChaos(books, { ...NO_CHAOS, liquidityCrunch: true }, Date.now());
  check("sequía reduce la liquidez visible", dry.map.a.bids[0].qty < books[0].bids[0].qty * 0.05);
  const now = Date.now();
  const shocked = applyChaos(
    books,
    { ...NO_CHAOS, shockVenue: "b", shockBps: -200, shockUntil: now + 10_000 },
    now,
  );
  check("shock mueve el precio del venue", shocked.map.b.bids[0].price < books[1].bids[0].price);
  check("el shock no toca otros venues", shocked.map.a.bids[0].price === books[0].bids[0].price);
  const expired = applyChaos(
    books,
    { ...NO_CHAOS, shockVenue: "b", shockBps: -200, shockUntil: now - 1 },
    now,
  );
  check("shock expirado no altera nada", expired.map.b.bids[0].price === books[1].bids[0].price);
}

console.log("circuit breaker:");
{
  const fresh = [book("a", 99, 100)];
  const cfg = { maxBookAgeMs: 6000, maxGrossBps: 150, maxConsecutiveLosses: 3, maxDrawdownUsd: 5000 };
  const okState = evaluateRisk(fresh, [], 0, 0, Date.now(), cfg, 0);
  check("mercado sano → breaker en reposo", !okState.tripped);
  const aborts = evaluateRisk(fresh, [], 0, 0, Date.now(), cfg, 3);
  check("3 abortos seguidos → breaker dispara", aborts.tripped);
  const dd = evaluateRisk(fresh, [], -6000, 0, Date.now(), cfg, 0);
  check("drawdown sobre el límite → breaker dispara", dd.tripped);
  const stale = evaluateRisk([book("a", 99, 100, Date.now() - 10_000)], [], 0, 0, Date.now(), cfg, 0);
  check("datos stale → breaker dispara", stale.tripped);
}

console.log("equity:");
{
  const w: Record<string, Wallet> = {
    a: { exchange: "a", usd: 1000, btc: 1 },
    b: { exchange: "b", usd: 500, btc: 0.5 },
  };
  check("totalEquity valúa BTC al precio de referencia", approx(totalEquity(w, 1000), 3000));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
