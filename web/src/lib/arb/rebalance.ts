// Rebalanceo automático de inventario entre exchanges.
// Cuando un venue se queda sin USD o sin BTC, su ruta de arbitraje se agota.
// Redistribuimos el inventario hacia objetivos parejos, pagando el costo real
// de las transferencias on-chain (withdrawal fees). El neto del rebalanceo
// reduce el P&L — el realismo importa: rebalancear no es gratis.
import { REBALANCE } from "./config";
import type { Wallet } from "./types";

/** ¿Algún venue está por debajo del mínimo de USD o BTC? */
export function needsRebalance(wallets: Record<string, Wallet>): boolean {
  return Object.values(wallets).some((w) => w.usd < REBALANCE.minUsd || w.btc < REBALANCE.minBtc);
}

/**
 * Redistribuye USD y BTC equitativamente entre venues.
 * Costo: cada venue que RECIBE BTC implica una transferencia on-chain que paga
 * el fee de red. El costo (valuado en USD) se descuenta del total.
 */
export function rebalance(
  wallets: Record<string, Wallet>,
  price: number,
): { wallets: Record<string, Wallet>; costUsd: number; transfers: number } {
  const ids = Object.keys(wallets);
  const n = ids.length;
  const totalUsd = ids.reduce((s, k) => s + wallets[k].usd, 0);
  const totalBtc = ids.reduce((s, k) => s + wallets[k].btc, 0);
  const targetUsd = totalUsd / n;
  const targetBtc = totalBtc / n;

  // Transferencias BTC = venues que necesitan recibir BTC (estaban por debajo del target).
  const transfers = ids.filter((k) => wallets[k].btc < targetBtc - 1e-9).length;
  const btcFee = transfers * REBALANCE.btcNetworkFee; // BTC quemados en fees de red
  const costUsd = btcFee * price;

  // BTC neto disponible tras pagar los fees de red, redistribuido parejo.
  const btcAfterFee = totalBtc - btcFee;
  const next: Record<string, Wallet> = {};
  for (const k of ids) {
    next[k] = { exchange: k, usd: targetUsd, btc: btcAfterFee / n };
  }
  return { wallets: next, costUsd, transfers };
}
