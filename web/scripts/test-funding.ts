// Tests del backtester de funding: cintas sintéticas con resultados
// verificables a mano. Corre con: pnpm test:funding
import {
  DEFAULT_FUNDING_PARAMS,
  alwaysInParams,
  inferPeriodsPerYear,
  runFundingBacktest,
} from "../src/lib/funding/backtest";
import type { FundingTick } from "../src/lib/funding/types";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`  ✖ ${msg}`);
  }
}
function approx(a: number, b: number, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}

const H8 = 8 * 3600 * 1000;
/** Cinta sintética: n periodos de 8h con el rate dado (constante o por función). */
function tape(n: number, rate: number | ((i: number) => number)): FundingTick[] {
  const t0 = Date.parse("2024-01-01T00:00:00Z");
  return Array.from({ length: n }, (_, i) => ({
    t: t0 + i * H8,
    rate: typeof rate === "function" ? rate(i) : rate,
  }));
}

// --- inferPeriodsPerYear ---
{
  const ppy = inferPeriodsPerYear(tape(100, 0.0001));
  assert(approx(ppy, 1095, 0.5), `periodos/año de cinta 8h ≈ 1095 (fue ${ppy})`);
  assert(inferPeriodsPerYear([]) === 1095, "serie vacía usa fallback 1095");
}

// --- Baseline siempre-dentro: funding constante, matemática exacta ---
{
  const p = { ...DEFAULT_FUNDING_PARAMS, capitalUsd: 10_000, notionalFrac: 1, roundTripCostPct: 0.4 };
  const n = 90; // 30 días
  const rate = 0.0001; // 1bp por periodo
  const r = runFundingBacktest(tape(n, rate), alwaysInParams(p));
  // Entra tras el primer tick (señal en i=0) → cobra en los ticks 1..n-1 = n-1 periodos.
  const expectedFunding = rate * 10_000 * (n - 1);
  assert(approx(r.fundingUsd, expectedFunding, 1e-9), `funding exacto: ${r.fundingUsd} vs ${expectedFunding}`);
  // Un ciclo completo: entrada + cierre forzado al final = costo ida+vuelta completo.
  assert(approx(r.feesUsd, 40, 1e-9), `fees = $40 ida+vuelta (fue ${r.feesUsd})`);
  assert(r.roundTrips === 1, `1 ciclo (fue ${r.roundTrips})`);
  assert(approx(r.netUsd, expectedFunding - 40, 1e-9), "neto = funding − fees");
}

// --- Umbral bloquea entrada cuando el funding no alcanza ---
{
  // 1bp/8h ≈ 10.95% anual → umbral de 20% nunca deja entrar.
  const p = { ...DEFAULT_FUNDING_PARAMS, entryAprPct: 20, windowPeriods: 3 };
  const r = runFundingBacktest(tape(60, 0.0001), p);
  assert(r.roundTrips === 0 && r.fundingUsd === 0 && r.feesUsd === 0, "umbral alto = nunca opera, cero fees");
}

// --- Histéresis: entra con funding alto, sale cuando se vuelve negativo ---
{
  // 30 periodos a 3bp (≈33% anual), luego 30 a −2bp (≈−22% anual).
  const p = { ...DEFAULT_FUNDING_PARAMS, entryAprPct: 8, exitAprPct: 0, windowPeriods: 3 };
  const r = runFundingBacktest(tape(60, (i) => (i < 30 ? 0.0003 : -0.0002)), p);
  assert(r.roundTrips === 1, `exactamente 1 ciclo (fue ${r.roundTrips})`);
  assert(r.timeInMarketPct > 30 && r.timeInMarketPct < 70, `en mercado ~50% (fue ${r.timeInMarketPct.toFixed(0)}%)`);
  // La ventana de 3 retrasa la salida como máximo ~3 periodos: pérdida acotada.
  const notional = p.capitalUsd * p.notionalFrac;
  assert(r.fundingUsd > 0.0003 * notional * 20, "cobró la mayor parte de la fase positiva");
  // El umbral evitó la fase negativa (bloqueado, no re-entra): mejor que siempre-dentro.
  const base = runFundingBacktest(tape(60, (i) => (i < 30 ? 0.0003 : -0.0002)), alwaysInParams(p));
  assert(r.netUsd > base.netUsd, `umbral ${r.netUsd.toFixed(2)} > baseline ${base.netUsd.toFixed(2)}`);
}

// --- Sin look-ahead: la señal del tick i no cobra el funding del tick i ---
{
  // Un solo periodo enorme al inicio: la señal lo ve DESPUÉS de que pasó.
  const p = { ...DEFAULT_FUNDING_PARAMS, entryAprPct: 8, exitAprPct: 0, windowPeriods: 1 };
  const r = runFundingBacktest(tape(10, (i) => (i === 0 ? 0.01 : -0.0001)), p);
  // Entra tras ver el tick 0, pero los ticks 1+ son negativos → no captura el 1%.
  const notional = p.capitalUsd * p.notionalFrac;
  assert(r.fundingUsd < 0.01 * notional * 0.5, `no capturó funding del pasado (fue ${r.fundingUsd.toFixed(2)})`);
}

// --- Drawdown: fase negativa dentro de posición genera DD medible ---
{
  const p = { ...DEFAULT_FUNDING_PARAMS, entryAprPct: 8, exitAprPct: -30, windowPeriods: 21 };
  const r = runFundingBacktest(tape(90, (i) => (i < 45 ? 0.0003 : -0.0003)), p);
  assert(r.maxDrawdownUsd > 0, `hay drawdown en la fase negativa (fue ${r.maxDrawdownUsd.toFixed(2)})`);
}

// --- byYear cuadra con el total ---
{
  const p = { ...DEFAULT_FUNDING_PARAMS };
  const r = runFundingBacktest(tape(400, 0.0002), p); // cruza de 2024 a 2024 (400×8h ≈ 133 días)
  const sumYears = r.byYear.reduce((s, y) => s + y.netUsd, 0);
  assert(approx(sumYears, r.netUsd, 1e-6), `suma por año (${sumYears.toFixed(4)}) = neto total (${r.netUsd.toFixed(4)})`);
}

console.log(`\nfunding backtest: ${passed} ok, ${failed} fallos`);
if (failed > 0) process.exit(1);
