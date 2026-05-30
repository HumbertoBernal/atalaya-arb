// Motor de arbitraje: detección, cálculo de rentabilidad neta y simulación.
// Funciones puras → testeables y deterministas.
import {
  BTC_VOL_PER_SEC,
  MAX_TRADE_BTC,
  NETWORK_LATENCY_MS,
  REBALANCE_EVERY,
  TAKER_FEE,
  WITHDRAWAL_FEE_BTC,
} from "./config";
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
): { latencyCost: number; withdrawalCost: number } {
  const latencySec = ((NETWORK_LATENCY_MS[buyEx] ?? 150) + (NETWORK_LATENCY_MS[sellEx] ?? 150)) / 1000;
  const adversePerBtc = avgPrice * BTC_VOL_PER_SEC * Math.sqrt(latencySec); // 1σ
  const latencyCost = adversePerBtc * qty;

  const withdrawalBtc = (WITHDRAWAL_FEE_BTC[buyEx] ?? 0) + (WITHDRAWAL_FEE_BTC[sellEx] ?? 0);
  const withdrawalCost = (withdrawalBtc / REBALANCE_EVERY) * avgPrice;

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

/** Detecta todas las oportunidades viables entre pares de exchanges.
 *  feeMult escala los fees (1 = retail; <1 simula tiers VIP/HFT). */
export function detectOpportunities(books: OrderBooks, feeMult = 1): Opportunity[] {
  const ids = Object.keys(books).filter((id) => books[id].ok && books[id].asks.length && books[id].bids.length);
  const opps: Opportunity[] = [];

  for (const buyEx of ids) {
    for (const sellEx of ids) {
      if (buyEx === sellEx) continue;
      const buyBook = books[buyEx];
      const sellBook = books[sellEx];
      const buyAsk = buyBook.asks[0].price;
      const sellBid = sellBook.bids[0].price;
      const grossSpread = sellBid - buyAsk;
      if (grossSpread <= 0) continue; // ni siquiera bruto

      const buyFee = (TAKER_FEE[buyEx] ?? 0.005) * feeMult;
      const sellFee = (TAKER_FEE[sellEx] ?? 0.005) * feeMult;
      const { qty, buyCost, sellProceeds } = optimalArb(
        buyBook.asks,
        sellBook.bids,
        buyFee,
        sellFee,
        MAX_TRADE_BTC,
      );

      const feesUsd = buyCost * buyFee + sellProceeds * sellFee;
      const avgPrice = qty > 0 ? buyCost / qty : buyAsk;
      const { latencyCost, withdrawalCost } = frictionCosts(buyEx, sellEx, qty, avgPrice);
      const netProfit = sellProceeds - buyCost - feesUsd - latencyCost - withdrawalCost;
      const netPerBtc = qty > 0 ? netProfit / qty : 0;

      opps.push({
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
        netBps: buyCost > 0 ? (netProfit / buyCost) * 10_000 : 0,
        viable: netProfit > 0 && qty > EPS,
      });
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
  feeMult = 1,
): { trade: Trade | null; wallets: Record<string, Wallet> } {
  const buyW = wallets[opp.buyEx];
  const sellW = wallets[opp.sellEx];
  const buyFee = (TAKER_FEE[opp.buyEx] ?? 0.005) * feeMult;
  const sellFee = (TAKER_FEE[opp.sellEx] ?? 0.005) * feeMult;

  // Tope por liquidez (recalculado) y por saldos disponibles.
  const liq = optimalArb(books[opp.buyEx].asks, books[opp.sellEx].bids, buyFee, sellFee, MAX_TRADE_BTC);
  let qty = liq.qty;
  if (qty <= EPS) return { trade: null, wallets };

  // Restricción de USD en buyEx: gasto = buyCost*(1+fee). Limitar qty proporcional.
  const maxByUsd = (buyW.usd / (liq.avgBuy * (1 + buyFee))) || 0;
  // Restricción de BTC en sellEx.
  const maxByBtc = sellW.btc;
  const requested = qty;
  qty = Math.min(qty, maxByUsd, maxByBtc);
  if (qty <= EPS) return { trade: null, wallets };

  // Re-walk para la qty final (precios promedio reales con slippage).
  const exec = optimalArb(books[opp.buyEx].asks, books[opp.sellEx].bids, buyFee, sellFee, qty);
  const buyCost = exec.buyCost;
  const sellProceeds = exec.sellProceeds;
  const buyFeeUsd = buyCost * buyFee;
  const sellFeeUsd = sellProceeds * sellFee;
  const grossProfit = sellProceeds - buyCost;
  const { latencyCost, withdrawalCost } = frictionCosts(opp.buyEx, opp.sellEx, exec.qty, exec.avgBuy);
  const netProfit = grossProfit - buyFeeUsd - sellFeeUsd - latencyCost - withdrawalCost;

  if (netProfit <= 0) return { trade: null, wallets };

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
  };

  return { trade, wallets: next };
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
