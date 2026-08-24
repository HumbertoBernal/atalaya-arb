// Backtest PURO de captura de funding delta-neutral (long spot + short perp).
// Misma filosofía que el motor de arbitraje: funciones puras, params inyectados,
// sin estado global, determinista sobre los mismos datos.
//
// SUPUESTOS (documentados, honestos):
// - Cuenta unificada (p. ej. Bybit UTA): el spot colateraliza el short → la
//   posición cubierta no se liquida por precio. Riesgo de contraparte NO modelado.
// - El P&L de la estrategia es SOLO funding − costos de entrada/salida. El
//   mark-to-market del basis fluctúa en el interín pero converge al cierre;
//   no lo modelamos (lo listamos como riesgo, no como cero).
// - Costos: taker en ambas patas + slippage, parametrizado como % ida+vuelta.
// - Señal: media móvil del funding anualizado con histéresis (entrada/salida).
import type { FundingBacktestParams, FundingBacktestResult, FundingTick, YearRow } from "./types";

export const DEFAULT_FUNDING_PARAMS: FundingBacktestParams = {
  capitalUsd: 5_000,
  notionalFrac: 0.9, // 10% de buffer — nunca desplegar el 100%
  entryAprPct: 8, // entrar solo si el funding anualizado supera 8%
  exitAprPct: 0, // salir cuando deja de pagar
  windowPeriods: 9, // media móvil de 3 días (9 periodos de 8h)
  roundTripCostPct: 0.39, // spot taker 0.1% + perp taker 0.055% + ~2bps slip c/pata, ida+vuelta
};

/** Periodos de funding por año, inferido del espaciado mediano real de la serie. */
export function inferPeriodsPerYear(ticks: FundingTick[]): number {
  if (ticks.length < 2) return 1095; // 3/día (8h) como fallback
  const gaps = [];
  for (let i = 1; i < ticks.length; i++) gaps.push(ticks[i].t - ticks[i - 1].t);
  gaps.sort((a, b) => a - b);
  const medianMs = gaps[Math.floor(gaps.length / 2)];
  return (365 * 24 * 3600 * 1000) / medianMs;
}

/** Media móvil del funding rate en los últimos `window` periodos, terminando en i (inclusive). */
function trailingMean(ticks: FundingTick[], i: number, window: number): number {
  const from = i - window + 1;
  if (from < 0) return NaN;
  let sum = 0;
  for (let k = from; k <= i; k++) sum += ticks[k].rate;
  return sum / window;
}

/**
 * Corre el backtest sobre una serie de funding. La señal en el tick i usa SOLO
 * información hasta i (sin look-ahead); la posición tomada cobra el funding a
 * partir del tick i+1.
 */
export function runFundingBacktest(ticks: FundingTick[], p: FundingBacktestParams): FundingBacktestResult {
  const periodsPerYear = inferPeriodsPerYear(ticks);
  const notional = p.capitalUsd * p.notionalFrac;
  const halfCost = (p.roundTripCostPct / 100 / 2) * notional; // costo de UNA transición (entrar o salir)

  let inPosition = false;
  let netUsd = 0;
  let fundingUsd = 0;
  let feesUsd = 0;
  let roundTrips = 0;
  let periodsIn = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  const equity: { t: number; usd: number }[] = [];
  const yearAgg = new Map<number, YearRow>();

  const yearOf = (t: number) => new Date(t).getUTCFullYear();
  const yearRow = (y: number): YearRow => {
    let r = yearAgg.get(y);
    if (!r) {
      r = { year: y, netUsd: 0, fundingUsd: 0, feesUsd: 0, timeInMarketPct: 0, roundTrips: 0, avgAprPct: 0 };
      yearAgg.set(y, r);
    }
    return r;
  };
  // Para time-in-market y funding medio por año necesitamos contar periodos por año.
  const yearPeriods = new Map<number, { total: number; in: number; rateSum: number }>();

  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i];
    const y = yearOf(tick.t);
    const yp = yearPeriods.get(y) ?? { total: 0, in: 0, rateSum: 0 };
    yp.total += 1;
    yp.rateSum += tick.rate;

    // 1) Cobrar funding del periodo con la posición que YA teníamos.
    if (inPosition) {
      const pnl = tick.rate * notional; // short cobra funding positivo
      fundingUsd += pnl;
      netUsd += pnl;
      periodsIn += 1;
      yp.in += 1;
      const r = yearRow(y);
      r.fundingUsd += pnl;
      r.netUsd += pnl;
    }
    yearPeriods.set(y, yp);

    // 2) Señal con datos hasta i → decide la posición para el SIGUIENTE periodo.
    const meanRate = trailingMean(ticks, i, p.windowPeriods);
    if (Number.isFinite(meanRate)) {
      const aprPct = meanRate * periodsPerYear * 100;
      if (!inPosition && aprPct > p.entryAprPct) {
        inPosition = true;
        netUsd -= halfCost;
        feesUsd += halfCost;
        const r = yearRow(y);
        r.feesUsd += halfCost;
        r.netUsd -= halfCost;
      } else if (inPosition && aprPct < p.exitAprPct) {
        inPosition = false;
        netUsd -= halfCost;
        feesUsd += halfCost;
        roundTrips += 1;
        const r = yearRow(y);
        r.feesUsd += halfCost;
        r.netUsd -= halfCost;
        r.roundTrips += 1;
      }
    }

    // 3) Curva de equity y drawdown.
    peak = Math.max(peak, netUsd);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - netUsd);
    // Muestrear la curva (~500 puntos) para no cargar miles al graficar.
    const stride = Math.max(1, Math.floor(ticks.length / 500));
    if (i % stride === 0 || i === ticks.length - 1) equity.push({ t: tick.t, usd: netUsd });
  }

  // Si terminamos dentro, cerrar la posición al final (costo de salida real).
  if (inPosition) {
    netUsd -= halfCost;
    feesUsd += halfCost;
    roundTrips += 1;
    const y = yearOf(ticks[ticks.length - 1].t);
    const r = yearRow(y);
    r.feesUsd += halfCost;
    r.netUsd -= halfCost;
    r.roundTrips += 1;
  }

  // Cerrar agregados por año.
  for (const [y, yp] of yearPeriods) {
    const r = yearRow(y);
    r.timeInMarketPct = yp.total ? (yp.in / yp.total) * 100 : 0;
    r.avgAprPct = yp.total ? (yp.rateSum / yp.total) * periodsPerYear * 100 : 0;
  }

  const fromTs = ticks[0]?.t ?? 0;
  const toTs = ticks[ticks.length - 1]?.t ?? 0;
  const years = Math.max((toTs - fromTs) / (365 * 24 * 3600 * 1000), 1e-9);

  return {
    params: p,
    periods: ticks.length,
    periodsPerYear,
    fromTs,
    toTs,
    netUsd,
    fundingUsd,
    feesUsd,
    aprOnCapitalPct: (netUsd / p.capitalUsd / years) * 100,
    roundTrips,
    timeInMarketPct: ticks.length ? (periodsIn / ticks.length) * 100 : 0,
    maxDrawdownUsd,
    byYear: [...yearAgg.values()].sort((a, b) => a.year - b.year),
    equity,
  };
}

/** Baseline "siempre dentro": entra el primer día y nunca sale. */
export function alwaysInParams(p: FundingBacktestParams): FundingBacktestParams {
  return { ...p, entryAprPct: -Infinity, exitAprPct: -Infinity, windowPeriods: 1 };
}
