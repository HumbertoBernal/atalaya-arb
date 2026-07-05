// Rebalanceo automático de inventario entre exchanges.
// Cuando un venue se queda sin USD o sin BTC, su ruta de arbitraje se agota.
// En vez de "resetear" todos los saldos parejos (irreal), planificamos
// TRANSFERENCIAS DIRIGIDAS: el venue más sobrado dona al que cayó bajo el
// mínimo, pagando el fee de red on-chain, y los fondos tardan en confirmar
// (transferDelaySec) — mientras viajan, no están disponibles para operar.
import { DEFAULT_PARAMS, type RebalanceParams } from "./params";
import type { Transfer, Wallet } from "./types";

const EPS = 1e-9;

/** ¿Algún venue está por debajo del mínimo de USD o BTC? */
export function needsRebalance(
  wallets: Record<string, Wallet>,
  cfg: RebalanceParams = DEFAULT_PARAMS.rebalance,
): boolean {
  return Object.values(wallets).some((w) => w.usd < cfg.minUsd || w.btc < cfg.minBtc);
}

/**
 * Saldos proyectados: lo que hay en el venue MÁS lo que viene en camino.
 * Evita disparar rebalanceos duplicados mientras una transferencia confirma.
 */
export function projectWallets(
  wallets: Record<string, Wallet>,
  pending: Transfer[],
): Record<string, Wallet> {
  if (!pending.length) return wallets;
  const next: Record<string, Wallet> = {};
  for (const [k, w] of Object.entries(wallets)) next[k] = { ...w };
  for (const t of pending) {
    const dst = next[t.to];
    if (!dst) continue;
    if (t.asset === "usd") dst.usd += t.amount;
    else dst.btc += t.amount;
  }
  return next;
}

/**
 * Planifica transferencias dirigidas para llevar a los venues deficitarios de
 * vuelta al promedio. Greedy: el donante con más excedente cubre primero al
 * receptor con mayor déficit. Cada transferencia BTC quema el fee de red.
 *
 * Los EXCEDENTES se miden sobre los saldos reales (`wallets`: lo gastable ya
 * debitado), pero los DÉFICITS sobre los proyectados (`opts.projected`: real +
 * en tránsito) — si a un venue ya le viene capital en camino, no se le vuelve
 * a enviar. `opts.canReceive` excluye receptores (p. ej. venues desactivados,
 * que pueden donar pero no recibir capital que no van a operar).
 */
export function planRebalance(
  wallets: Record<string, Wallet>,
  price: number,
  cfg: RebalanceParams = DEFAULT_PARAMS.rebalance,
  now: number = Date.now(),
  opts: { projected?: Record<string, Wallet>; canReceive?: (ex: string) => boolean } = {},
): { transfers: Transfer[]; costUsd: number } {
  const ids = Object.keys(wallets);
  const n = ids.length;
  if (n < 2) return { transfers: [], costUsd: 0 };
  const projected = opts.projected ?? wallets;
  const canReceive = opts.canReceive ?? (() => true);

  const transfers: Transfer[] = [];
  let feeBtcTotal = 0;
  let seq = 0;

  for (const asset of ["usd", "btc"] as const) {
    const min = asset === "usd" ? cfg.minUsd : cfg.minBtc;
    const bal = (k: string) => (asset === "usd" ? wallets[k].usd : wallets[k].btc);
    const balProj = (k: string) => {
      const p = projected[k];
      return p ? (asset === "usd" ? p.usd : p.btc) : bal(k);
    };
    const target = ids.reduce((s, k) => s + bal(k), 0) / n;
    if (target <= min) continue; // no hay suficiente en total para sanear

    // Déficits pendientes por receptor (proyectados) y excedentes por donante.
    const deficit = new Map(
      ids.filter((k) => canReceive(k) && balProj(k) < min).map((k) => [k, target - balProj(k)]),
    );
    const excess = new Map(ids.filter((k) => bal(k) > target + EPS).map((k) => [k, bal(k) - target]));

    const donors = [...excess.keys()].sort((a, b) => (excess.get(b) ?? 0) - (excess.get(a) ?? 0));
    for (const [to, needRaw] of [...deficit.entries()].sort((a, b) => b[1] - a[1])) {
      let need = needRaw;
      for (const from of donors) {
        if (need <= EPS) break;
        const exc = excess.get(from) ?? 0;
        if (exc <= EPS) continue;
        const gross = Math.min(exc, need);
        const feeBtc = asset === "btc" ? Math.min(cfg.btcNetworkFee, gross) : 0;
        const amount = gross - feeBtc; // lo que llega al destino
        if (amount <= EPS) continue;
        transfers.push({
          id: `${asset}-${from}-${to}-${now}-${seq++}`,
          from,
          to,
          asset,
          amount,
          feeBtc,
          sentTs: now,
          arriveTs: now + cfg.transferDelaySec * 1000,
        });
        feeBtcTotal += feeBtc;
        excess.set(from, exc - gross);
        need -= gross;
      }
    }
  }

  return { transfers, costUsd: feeBtcTotal * price };
}

/** Aplica las SALIDAS: el origen paga monto + fee inmediatamente. */
export function debitTransfers(
  wallets: Record<string, Wallet>,
  transfers: Transfer[],
): Record<string, Wallet> {
  if (!transfers.length) return wallets;
  const next: Record<string, Wallet> = {};
  for (const [k, w] of Object.entries(wallets)) next[k] = { ...w };
  for (const t of transfers) {
    const src = next[t.from];
    if (!src) continue;
    if (t.asset === "usd") src.usd -= t.amount;
    else src.btc -= t.amount + t.feeBtc;
  }
  return next;
}

/** Acredita una transferencia que ya confirmó en el destino. */
export function creditTransfer(
  wallets: Record<string, Wallet>,
  t: Transfer,
): Record<string, Wallet> {
  if (!wallets[t.to]) return wallets; // destino desconocido (snapshot de otro esquema)
  const next = { ...wallets, [t.to]: { ...wallets[t.to] } };
  if (t.asset === "usd") next[t.to].usd += t.amount;
  else next[t.to].btc += t.amount;
  return next;
}
