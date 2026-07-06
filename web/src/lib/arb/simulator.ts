// Simulador headless de una sesión de trading: TODA la lógica de un tick
// (detección → dos fases → abortos → breaker con cooldown → rebalanceo →
// contabilidad) como función pura sobre un estado inmutable.
//
// Tres consumidores comparten este núcleo:
//  1. useArbEngine — el motor primario del dashboard,
//  2. el Laboratorio — N configs corriendo en paralelo sobre el mismo mercado,
//  3. scripts/experiment.ts — replay determinista de una cinta grabada.
import { EQUITY_WINDOW, EXCHANGES, TRADES_MAX } from "./config";
import {
  abortedTrade,
  detectOpportunities,
  recheckOpportunity,
  simulateExecution,
} from "./engine";
import { referencePrice } from "./mergeBooks";
import { isActive, type EngineParams } from "./params";
import {
  creditTransfer,
  debitTransfers,
  needsRebalance,
  planRebalance,
  projectWallets,
} from "./rebalance";
import { evaluateRisk, sanitizeOpportunities, type RiskState } from "./risk";
import type { OrderBook, OrderBooks, Opportunity, Trade, Transfer, Wallet } from "./types";

export type SessionStats = {
  oppsSeen: number;
  viableSeen: number;
  filledCount: number; // fills acumulados (el ledger visible se capa a TRADES_MAX)
  partialCount: number;
  volumeBtc: number;
  bestTrade: number;
  rebalances: number;
  aborted: number;
  startTs: number;
};

export const emptyStats = (startTs = 0): SessionStats => ({
  oppsSeen: 0,
  viableSeen: 0,
  filledCount: 0,
  partialCount: 0,
  volumeBtc: 0,
  bestTrade: 0,
  rebalances: 0,
  aborted: 0,
  startTs,
});

// Orden en dos fases: detectada en el tick N, re-verificada y ejecutada (o
// abortada) contra el libro fresco del tick N+1 — la ventana de ejecución.
export type PendingOrder = { opp: Opportunity; createdTs: number };

export type SimState = {
  wallets: Record<string, Wallet>;
  pnl: number;
  peakPnl: number;
  pending: PendingOrder[];
  transfers: Transfer[]; // rebalanceos en tránsito (confirmación on-chain)
  consecutiveAborts: number;
  breakerUntil: number; // epoch ms del auto-rearm; 0 = sin cooldown en curso
  trades: Trade[]; // más reciente primero, capped
  stats: SessionStats;
  equity: { t: number; pnl: number }[];
};

export type StepResult = {
  state: SimState;
  detectedRaw: Opportunity[];
  detected: Opportunity[]; // sanitizadas (sin spreads corruptos)
  risk: RiskState;
};

export function initWallets(p: EngineParams): Record<string, Wallet> {
  const w: Record<string, Wallet> = {};
  for (const ex of EXCHANGES) w[ex] = { exchange: ex, usd: p.initialUsd, btc: p.initialBtc };
  return w;
}

export function initSimState(p: EngineParams, startTs = 0): SimState {
  return {
    wallets: initWallets(p),
    pnl: 0,
    peakPnl: 0,
    pending: [],
    transfers: [],
    consecutiveAborts: 0,
    breakerUntil: 0,
    trades: [],
    stats: emptyStats(startTs),
    equity: [],
  };
}

/** Re-armado del breaker: resetea la racha de abortos y toma el P&L actual
 *  como nuevo pico (presupuesto de drawdown fresco). Lo usan el botón manual
 *  y el auto-rearm por cooldown. */
export function rearm(state: SimState): SimState {
  return { ...state, consecutiveAborts: 0, peakPnl: state.pnl, breakerUntil: 0 };
}

/** Avanza la sesión un tick sobre los libros dados. Puro: no muta `prev`. */
export function stepSession(
  prev: SimState,
  map: OrderBooks,
  merged: OrderBook[],
  p: EngineParams,
  now: number,
  running = true,
): StepResult {
  let state: SimState = { ...prev, stats: { ...prev.stats } };

  // Detección sobre el universo activo de ESTA config.
  const detectedRaw = detectOpportunities(map, p);
  const detected = sanitizeOpportunities(detectedRaw, p.risk.maxGrossBps);
  state.stats.oppsSeen += detectedRaw.length;
  state.stats.viableSeen += detected.filter((o) => o.viable).length;

  // Auto-rearm: cumplido el cooldown, el bot se recupera solo (racha a cero,
  // pico = P&L actual). Si el mercado sigue hostil, volverá a dispararse.
  if (state.breakerUntil > 0 && now >= state.breakerUntil) {
    state = rearm(state);
  }

  // Circuit breaker (incluye la racha de abortos de ticks anteriores).
  const risk = evaluateRisk(merged, detectedRaw, state.pnl, state.peakPnl, now, p.risk, state.consecutiveAborts);
  if (risk.tripped && state.breakerUntil === 0 && p.risk.cooldownSec > 0) {
    state.breakerUntil = now + p.risk.cooldownSec * 1000;
  }
  if (!risk.tripped) state.breakerUntil = 0;

  let w = state.wallets;
  let walletsTouched = false;

  // Llegadas de transferencias: confirman aunque el breaker esté activo.
  const arrivals = state.transfers.filter((t) => now >= t.arriveTs);
  if (arrivals.length) {
    for (const t of arrivals) w = creditTransfer(w, t);
    state.transfers = state.transfers.filter((t) => now < t.arriveTs);
    walletsTouched = true;
  }

  const newTrades: Trade[] = [];
  let gained = 0;

  if (running && !risk.tripped) {
    // FASE 2: órdenes creadas el tick pasado se re-verifican contra el libro
    // fresco. Si el neto se derrumbó o el spread se cerró → aborto (visible).
    const pend = state.pending;
    state.pending = [];
    for (const po of pend) {
      // Venue desactivado con la orden en vuelo → se cancela sin ejecutar.
      if (!isActive(p, po.opp.buyEx) || !isActive(p, po.opp.sellEx)) continue;
      const rc = recheckOpportunity(po.opp, map, p);
      if (rc.ok && rc.fresh) {
        const { trade, wallets: nextW } = simulateExecution(rc.fresh, map, w, p);
        if (trade) {
          trade.driftBps = rc.driftBps;
          w = nextW;
          walletsTouched = true;
          newTrades.push(trade);
          gained += trade.netProfit;
          state.consecutiveAborts = 0;
          continue;
        }
        newTrades.push(abortedTrade(po.opp, "liquidez o saldo insuficiente al ejecutar", rc.driftBps));
      } else {
        newTrades.push(abortedTrade(po.opp, rc.reason ?? "condiciones cambiaron", rc.driftBps));
      }
      // Cuenta por ORDEN abortada (un tick adverso con varias pendientes
      // puede disparar el breaker de golpe — comportamiento deseado).
      state.consecutiveAborts += 1;
      state.stats.aborted += 1;
    }

    // FASE 1: lo viable detectado ahora entra como orden pendiente y se
    // ejecutará (o abortará) el próximo tick — la ventana de ejecución.
    // (detectOpportunities produce cada par a lo sumo una vez.)
    for (const opp of detected.filter((o) => o.viable)) {
      state.pending = [...state.pending, { opp, createdTs: now }];
    }

    // Rebalanceo dirigido si algún venue ACTIVO se agotó y no viene nada en
    // camino: déficits sobre saldos proyectados (real + en tránsito) para no
    // duplicar envíos; venues desactivados donan pero no reciben.
    const projected = projectWallets(w, state.transfers);
    const activeProjected = Object.fromEntries(
      Object.entries(projected).filter(([ex]) => isActive(p, ex)),
    );
    const refP = referencePrice(merged);
    if (refP && needsRebalance(activeProjected, p.rebalance)) {
      const plan = planRebalance(w, refP, p.rebalance, now, {
        projected,
        canReceive: (ex) => isActive(p, ex),
      });
      if (plan.transfers.length) {
        w = debitTransfers(w, plan.transfers);
        state.transfers = [...state.transfers, ...plan.transfers];
        walletsTouched = true;
        state.pnl -= plan.costUsd;
        state.stats.rebalances += 1;
      }
    }
  } else if (state.pending.length) {
    // Breaker activo o pausa: las órdenes pendientes se cancelan sin ejecutar.
    state.pending = [];
  }

  if (newTrades.length) {
    state.pnl += gained;
    state.peakPnl = Math.max(state.peakPnl, state.pnl);
    state.trades = [...[...newTrades].reverse(), ...state.trades].slice(0, TRADES_MAX);
    for (const tr of newTrades) {
      if (tr.status !== "filled") continue;
      state.stats.filledCount += 1;
      if (tr.partial) state.stats.partialCount += 1;
      state.stats.volumeBtc += tr.qty;
      state.stats.bestTrade = Math.max(state.stats.bestTrade, tr.netProfit);
    }
  }
  if (walletsTouched) state.wallets = w;

  state.equity = [...state.equity, { t: now, pnl: state.pnl }].slice(-EQUITY_WINDOW);

  return { state, detectedRaw, detected, risk };
}
