// Motor de arbitraje: detección, cálculo de rentabilidad neta y simulación.
// Funciones puras → testeables y deterministas. Todos los tunables llegan por
// EngineParams (inyección explícita): nada se lee de estado global, así la UI
// puede reconfigurar el motor en runtime sin recargar.
import { DEFAULT_PARAMS, feeOf, isActive, type EngineParams } from "./params";
import type { Level, OrderBook, OrderBooks, Opportunity, Trade, Wallet } from "./types";

const EPS = 1e-9;

/**
 * Fricciones más allá de fees/slippage (exigidas por el enunciado):
 * - Latencia de red → adverse selection: el precio puede moverse en contra
 *   durante la ventana de ejecución. Modelado como un movimiento de 1σ sobre
 *   la latencia combinada de ambos exchanges.
 * - Withdrawal fee amortizado: el arbitraje pre-posicionado rebalancea cada
 *   N operaciones; el costo on-chain se reparte entre ellas.
 */
export function frictionCosts(
  buyEx: string,
  sellEx: string,
  qty: number,
  avgPrice: number,
  p: EngineParams = DEFAULT_PARAMS,
): { latencyCost: number; withdrawalCost: number } {
  const latencySec = ((p.latencyMs[buyEx] ?? 150) + (p.latencyMs[sellEx] ?? 150)) / 1000;
  const adversePerBtc = avgPrice * p.btcVolPerSec * Math.sqrt(latencySec); // 1σ
  const latencyCost = adversePerBtc * qty;

  const withdrawalBtc = (p.withdrawalFeeBtc[buyEx] ?? 0) + (p.withdrawalFeeBtc[sellEx] ?? 0);
  const withdrawalCost = (withdrawalBtc / p.rebalanceEvery) * avgPrice;

  return { latencyCost, withdrawalCost };
}

/**
 * Tamaño óptimo de arbitraje por profitabilidad MARGINAL.
 * Recorre asks (compra) y bids (venta) nivel por nivel y sigue ejecutando
 * mientras el ingreso marginal de venta (neto de fee) supere al costo marginal
 * de compra (neto de fee). Esto incorpora slippage y fills parciales de forma
 * nativa, y maximiza la ganancia neta sin ejecutar volumen no rentable.
 */
export function optimalArb(
  asks: Level[], // ascendente (compramos aquí)
  bids: Level[], // descendente (vendemos aquí)
  buyFee: number,
  sellFee: number,
  maxBtc: number,
): { qty: number; buyCost: number; sellProceeds: number; avgBuy: number; avgSell: number } {
  let i = 0;
  let j = 0;
  let qty = 0;
  let buyCost = 0;
  let sellProceeds = 0;
  let aRem = asks[0]?.qty ?? 0;
  let bRem = bids[0]?.qty ?? 0;

  while (i < asks.length && j < bids.length && qty < maxBtc - EPS) {
    const ask = asks[i].price;
    const bid = bids[j].price;
    // ¿sigue siendo rentable en el margen?
    if (bid * (1 - sellFee) <= ask * (1 + buyFee) + EPS) break;

    const step = Math.min(aRem, bRem, maxBtc - qty);
    if (step <= EPS) break;

    qty += step;
    buyCost += ask * step;
    sellProceeds += bid * step;
    aRem -= step;
    bRem -= step;

    if (aRem <= EPS) {
      i += 1;
      aRem = asks[i]?.qty ?? 0;
    }
    if (bRem <= EPS) {
      j += 1;
      bRem = bids[j]?.qty ?? 0;
    }
  }

  return {
    qty,
    buyCost,
    sellProceeds,
    avgBuy: qty > 0 ? buyCost / qty : 0,
    avgSell: qty > 0 ? sellProceeds / qty : 0,
  };
}

/**
 * Evalúa el par (buyEx → sellEx) sobre los libros actuales: núcleo compartido
 * por la detección y la re-verificación pre-ejecución (dos fases).
 */
export function evalPair(
  buyEx: string,
  sellEx: string,
  books: OrderBooks,
  p: EngineParams = DEFAULT_PARAMS,
): Opportunity | null {
  const buyBook = books[buyEx];
  const sellBook = books[sellEx];
  if (!buyBook?.ok || !sellBook?.ok || !buyBook.asks.length || !sellBook.bids.length) return null;

  const buyAsk = buyBook.asks[0].price;
  const sellBid = sellBook.bids[0].price;
  const grossSpread = sellBid - buyAsk;

  const buyFee = feeOf(p, buyEx);
  const sellFee = feeOf(p, sellEx);
  const { qty, buyCost, sellProceeds } = optimalArb(buyBook.asks, sellBook.bids, buyFee, sellFee, p.maxTradeBtc);

  const feesUsd = buyCost * buyFee + sellProceeds * sellFee;
  const avgPrice = qty > 0 ? buyCost / qty : buyAsk;
  const { latencyCost, withdrawalCost } = frictionCosts(buyEx, sellEx, qty, avgPrice, p);
  const netProfit = sellProceeds - buyCost - feesUsd - latencyCost - withdrawalCost;
  const netPerBtc = qty > 0 ? netProfit / qty : 0;
  const netBps = buyCost > 0 ? (netProfit / buyCost) * 10_000 : 0;

  return {
    buyEx,
    sellEx,
    buyAsk,
    sellBid,
    grossSpread,
    grossBps: (grossSpread / buyAsk) * 10_000,
    maxQty: qty,
    feesCost: feesUsd,
    latencyCost,
    withdrawalCost,
    netPerBtc,
    netProfit,
    netBps,
    // Viable = neto positivo Y por encima del umbral configurado por el usuario.
    viable: netProfit > 0 && qty > EPS && netBps >= p.minNetBps,
  };
}

/** Detecta todas las oportunidades entre pares de exchanges ACTIVOS. */
export function detectOpportunities(books: OrderBooks, p: EngineParams = DEFAULT_PARAMS): Opportunity[] {
  const ids = Object.keys(books).filter(
    (id) => books[id].ok && books[id].asks.length && books[id].bids.length && isActive(p, id),
  );
  const opps: Opportunity[] = [];

  for (const buyEx of ids) {
    for (const sellEx of ids) {
      if (buyEx === sellEx) continue;
      const opp = evalPair(buyEx, sellEx, books, p);
      if (!opp || opp.grossSpread <= 0) continue; // ni siquiera bruto
      opps.push(opp);
    }
  }

  return opps.sort((a, b) => b.netProfit - a.netProfit);
}

/**
 * Simula la ejecución de una oportunidad respetando saldos de wallet.
 * Reduce el volumen (fill parcial) si falta USD en buyEx o BTC en sellEx.
 */
export function simulateExecution(
  opp: Opportunity,
  books: OrderBooks,
  wallets: Record<string, Wallet>,
  p: EngineParams = DEFAULT_PARAMS,
): { trade: Trade | null; wallets: Record<string, Wallet> } {
  const buyW = wallets[opp.buyEx];
  const sellW = wallets[opp.sellEx];
  if (!buyW || !sellW) return { trade: null, wallets };
  const buyFee = feeOf(p, opp.buyEx);
  const sellFee = feeOf(p, opp.sellEx);

  // Tope por liquidez (recalculado) y por saldos disponibles.
  const liq = optimalArb(books[opp.buyEx].asks, books[opp.sellEx].bids, buyFee, sellFee, p.maxTradeBtc);
  let qty = liq.qty;
  if (qty <= EPS) return { trade: null, wallets };

  // Restricción de USD en buyEx: gasto = buyCost*(1+fee). Limitar qty proporcional.
  const maxByUsd = (buyW.usd / (liq.avgBuy * (1 + buyFee))) || 0;
  // Restricción de BTC en sellEx.
  const maxByBtc = sellW.btc;
  const requested = qty;
  qty = Math.min(qty, maxByUsd, maxByBtc);
  // Modo maker: la orden límite solo se llena con cierta probabilidad antes de
  // que el spread se cierre → el volumen esperado ejecutado es menor.
  if (p.maker) qty *= p.makerFillProb;
  if (qty <= EPS) return { trade: null, wallets };

  // Re-walk para la qty final (precios promedio reales con slippage).
  const exec = optimalArb(books[opp.buyEx].asks, books[opp.sellEx].bids, buyFee, sellFee, qty);
  const buyCost = exec.buyCost;
  const sellProceeds = exec.sellProceeds;
  const buyFeeUsd = buyCost * buyFee;
  const sellFeeUsd = sellProceeds * sellFee;
  const grossProfit = sellProceeds - buyCost;
  const { latencyCost, withdrawalCost } = frictionCosts(opp.buyEx, opp.sellEx, exec.qty, exec.avgBuy, p);
  const netProfit = grossProfit - buyFeeUsd - sellFeeUsd - latencyCost - withdrawalCost;

  if (netProfit <= 0) return { trade: null, wallets };
  // Umbral configurado: por debajo del margen mínimo tampoco ejecutamos.
  if (buyCost > 0 && (netProfit / buyCost) * 10_000 < p.minNetBps) return { trade: null, wallets };

  // Actualizar wallets.
  const next = { ...wallets };
  next[opp.buyEx] = {
    ...buyW,
    usd: buyW.usd - buyCost - buyFeeUsd,
    btc: buyW.btc + exec.qty,
  };
  next[opp.sellEx] = {
    ...sellW,
    // proceeds netos de fee y de la fricción modelada (latencia + retiro amortizado)
    usd: sellW.usd + sellProceeds - sellFeeUsd - latencyCost - withdrawalCost,
    btc: sellW.btc - exec.qty,
  };

  const trade: Trade = {
    id: `${opp.buyEx}-${opp.sellEx}-${books[opp.buyEx].ts}`,
    ts: Date.now(),
    buyEx: opp.buyEx,
    sellEx: opp.sellEx,
    qty: exec.qty,
    requestedQty: requested,
    avgBuyPrice: exec.avgBuy,
    avgSellPrice: exec.avgSell,
    buyFee: buyFeeUsd,
    sellFee: sellFeeUsd,
    grossProfit,
    netProfit,
    partial: exec.qty < requested - EPS,
    status: "filled",
  };

  return { trade, wallets: next };
}

/**
 * Re-verificación pre-ejecución (fase 2 de la ejecución en dos fases):
 * la orden se creó sobre un snapshot y el mercado siguió moviéndose. Sobre los
 * libros FRESCOS decide si sigue valiendo la pena:
 *  - neto fresco ≤ 0 → abortar (el spread se cerró);
 *  - el neto cayó más de recheckTolBps vs lo esperado → abortar (deriva excesiva).
 */
export function recheckOpportunity(
  expected: Opportunity,
  freshBooks: OrderBooks,
  p: EngineParams = DEFAULT_PARAMS,
): { ok: boolean; fresh: Opportunity | null; driftBps: number; reason?: string } {
  const fresh = evalPair(expected.buyEx, expected.sellEx, freshBooks, p);
  if (!fresh || fresh.maxQty <= EPS || fresh.netProfit <= 0) {
    const driftBps = expected.netBps - (fresh?.netBps ?? 0);
    return { ok: false, fresh, driftBps, reason: "el spread se cerró durante la ejecución" };
  }
  const driftBps = expected.netBps - fresh.netBps;
  if (driftBps > p.recheckTolBps) {
    return { ok: false, fresh, driftBps, reason: `deriva ${driftBps.toFixed(1)} bps > tolerancia` };
  }
  if (fresh.netBps < p.minNetBps) {
    return { ok: false, fresh, driftBps, reason: "cayó bajo el umbral mínimo" };
  }
  return { ok: true, fresh, driftBps };
}

/** Entrada de ledger para una orden abortada por la re-verificación. */
export function abortedTrade(opp: Opportunity, reason: string, driftBps: number): Trade {
  return {
    id: `abort-${opp.buyEx}-${opp.sellEx}-${Date.now()}`,
    ts: Date.now(),
    buyEx: opp.buyEx,
    sellEx: opp.sellEx,
    qty: 0,
    requestedQty: opp.maxQty,
    avgBuyPrice: opp.buyAsk,
    avgSellPrice: opp.sellBid,
    buyFee: 0,
    sellFee: 0,
    grossProfit: 0,
    netProfit: 0,
    partial: false,
    status: "aborted",
    driftBps,
    abortReason: reason,
  };
}

/** Valor total en USD de todas las wallets (BTC valuado a un precio de referencia). */
export function totalEquity(wallets: Record<string, Wallet>, btcRef: number): number {
  return Object.values(wallets).reduce((sum, w) => sum + w.usd + w.btc * btcRef, 0);
}

/** Mejor precio medio de BTC entre exchanges (mid del mejor bid/ask). */
export function refPrice(book: OrderBook | undefined): number | null {
  if (!book?.ok || !book.bids.length || !book.asks.length) return null;
  return (book.bids[0].price + book.asks[0].price) / 2;
}
