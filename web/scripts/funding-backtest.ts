// Backtest de captura de funding sobre los JSONL descargados con funding:fetch.
//
//   pnpm funding:backtest                    → todas las series, config default + baseline
//   pnpm funding:backtest binance-BTCUSDT    → una serie concreta
//   pnpm funding:backtest binance-BTCUSDT --sweep  → barrido entrada×salida×ventana
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_FUNDING_PARAMS,
  alwaysInParams,
  runFundingBacktest,
} from "../src/lib/funding/backtest";
import type { FundingBacktestResult, FundingTick } from "../src/lib/funding/types";

const DATA_DIR = join(process.cwd(), "data", "funding");
const args = process.argv.slice(2);
const sweep = args.includes("--sweep");
const wanted = args.filter((a) => !a.startsWith("--"));

const usd = (v: number) => `${v < 0 ? "-" : "+"}$${Math.abs(v).toFixed(2)}`;
const pct = (v: number, d = 1) => `${v.toFixed(d)}%`;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

function loadTicks(name: string): FundingTick[] {
  const file = join(DATA_DIR, `${name}.jsonl`);
  if (!existsSync(file)) throw new Error(`No existe ${file} — corre primero: pnpm funding:fetch`);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FundingTick);
}

function printResult(label: string, r: FundingBacktestResult) {
  console.log(
    `  ${label.padEnd(26)} neto ${usd(r.netUsd).padStart(10)} · ${pct(r.aprOnCapitalPct)}/año` +
      ` · funding ${usd(r.fundingUsd)} · fees ${usd(-r.feesUsd)}` +
      ` · en mercado ${pct(r.timeInMarketPct, 0)} · ${r.roundTrips} ciclos · maxDD ${usd(-r.maxDrawdownUsd)}`,
  );
}

function printYears(r: FundingBacktestResult) {
  console.log("    año   neto        funding     fees      en-mercado  ciclos  funding-medio-mercado");
  for (const y of r.byYear) {
    console.log(
      `    ${y.year}  ${usd(y.netUsd).padStart(9)}  ${usd(y.fundingUsd).padStart(9)}  ${usd(-y.feesUsd).padStart(8)}` +
        `  ${pct(y.timeInMarketPct, 0).padStart(9)}  ${String(y.roundTrips).padStart(5)}  ${pct(y.avgAprPct).padStart(8)}`,
    );
  }
}

function runSeries(name: string) {
  const ticks = loadTicks(name);
  console.log(`\n━━ ${name} · ${ticks.length} periodos (${day(ticks[0].t)} → ${day(ticks[ticks.length - 1].t)})`);
  console.log(
    `   capital $${DEFAULT_FUNDING_PARAMS.capitalUsd} · notional ${pct(DEFAULT_FUNDING_PARAMS.notionalFrac * 100, 0)}` +
      ` · costo ida+vuelta ${pct(DEFAULT_FUNDING_PARAMS.roundTripCostPct, 2)}`,
  );

  const strat = runFundingBacktest(ticks, DEFAULT_FUNDING_PARAMS);
  const base = runFundingBacktest(ticks, alwaysInParams(DEFAULT_FUNDING_PARAMS));
  printResult(`umbral ${DEFAULT_FUNDING_PARAMS.entryAprPct}%→${DEFAULT_FUNDING_PARAMS.exitAprPct}%`, strat);
  printResult("baseline siempre-dentro", base);
  console.log("  Por año (estrategia con umbral):");
  printYears(strat);

  if (sweep) {
    console.log("\n  Sweep entrada×salida×ventana (top 10 por neto):");
    const rows: { label: string; r: FundingBacktestResult }[] = [];
    for (const entry of [0, 3, 5, 8, 10, 15])
      for (const exit of [-5, -2, 0, 2])
        for (const window of [3, 9, 21]) {
          if (exit >= entry) continue; // histéresis: salida debe estar debajo de entrada
          const r = runFundingBacktest(ticks, { ...DEFAULT_FUNDING_PARAMS, entryAprPct: entry, exitAprPct: exit, windowPeriods: window });
          rows.push({ label: `entra>${entry}% sale<${exit}% vent=${window}`, r });
        }
    rows.sort((a, b) => b.r.netUsd - a.r.netUsd);
    for (const { label, r } of rows.slice(0, 10)) printResult(label, r);
    console.log("  … y los 3 peores (para ver el costo de equivocarse):");
    for (const { label, r } of rows.slice(-3)) printResult(label, r);
  }
}

const names = wanted.length
  ? wanted
  : readdirSync(DATA_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""))
      .sort();

if (!names.length) {
  console.error("No hay datos en data/funding — corre primero: pnpm funding:fetch");
  process.exit(1);
}
for (const n of names) runSeries(n);

console.log(
  "\nHonestidad: esto modela SOLO funding − costos de transición. No modela mark-to-market" +
    "\ndel basis en el interín, riesgo de contraparte del exchange, ni depeg de USDT." +
    "\nBacktest positivo ≠ dinero: el siguiente gate es paper trading real en testnet.",
);
