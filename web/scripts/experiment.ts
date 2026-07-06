// Barrido de configuraciones sobre una cinta grabada (ver record-tape.ts):
// cada config se replaya contra EXACTAMENTE los mismos ticks de mercado, con
// el simulador completo (dos fases, abortos, breaker con cooldown, rebalanceo).
// Determinista y reproducible — la evidencia detrás de los defaults del motor.
//
// Uso: pnpm experiment <cinta.jsonl>          → los 3 presets + defaults
//      pnpm experiment <cinta.jsonl> --grid   → además, grilla umbral × tolerancia
import { readFileSync } from "node:fs";
import { freshDefaults, PRESETS, type EngineParams } from "../src/lib/arb/params";
import { initSimState, stepSession, type SimState } from "../src/lib/arb/simulator";
import type { OrderBook, OrderBooks } from "../src/lib/arb/types";

type Tick = { ts: number; books: OrderBook[] };

function loadTape(path: string): Tick[] {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const ticks: Tick[] = [];
  for (const line of lines) {
    try {
      const t = JSON.parse(line) as Tick;
      if (t.ts && Array.isArray(t.books)) ticks.push(t);
    } catch {
      /* línea corrupta (grabación interrumpida): se salta */
    }
  }
  return ticks;
}

type RunResult = {
  label: string;
  pnl: number;
  filled: number;
  partial: number;
  aborted: number;
  viable: number;
  volumeBtc: number;
  rebalances: number;
  maxDrawdown: number;
};

function replay(label: string, params: EngineParams, ticks: Tick[]): RunResult {
  let state: SimState = initSimState(params, ticks[0]?.ts ?? 0);
  let peak = 0;
  let maxDD = 0;
  for (const tick of ticks) {
    const map: OrderBooks = {};
    for (const b of tick.books) map[b.exchange] = b;
    state = stepSession(state, map, tick.books, params, tick.ts, true).state;
    peak = Math.max(peak, state.pnl);
    maxDD = Math.max(maxDD, peak - state.pnl);
  }
  return {
    label,
    pnl: state.pnl,
    filled: state.stats.filledCount,
    partial: state.stats.partialCount,
    aborted: state.stats.aborted,
    viable: state.stats.viableSeen,
    volumeBtc: state.stats.volumeBtc,
    rebalances: state.stats.rebalances,
    maxDrawdown: maxDD,
  };
}

function main() {
  const tapePath = process.argv[2];
  const grid = process.argv.includes("--grid");
  if (!tapePath) {
    console.error("Uso: pnpm experiment <cinta.jsonl> [--grid]");
    process.exit(1);
  }
  const ticks = loadTape(tapePath);
  if (ticks.length < 10) {
    console.error(`Cinta demasiado corta (${ticks.length} ticks). Graba más con: pnpm tape 15`);
    process.exit(1);
  }
  const durMin = ((ticks[ticks.length - 1].ts - ticks[0].ts) / 60_000).toFixed(1);
  console.log(`Cinta: ${tapePath} — ${ticks.length} ticks · ${durMin} min de mercado real\n`);

  // Configs: defaults + los 3 presets (aplicados sobre defaults) + grilla opcional.
  const configs: { label: string; params: EngineParams }[] = [
    { label: "Defaults", params: freshDefaults() },
    ...PRESETS.map((pr) => ({ label: `Preset ${pr.label}`, params: pr.apply(freshDefaults()) })),
  ];
  if (grid) {
    for (const minNetBps of [0, 2, 5, 10]) {
      for (const recheckTolBps of [2, 5, 12]) {
        configs.push({
          label: `umbral=${minNetBps} tol=${recheckTolBps}`,
          params: { ...freshDefaults(), minNetBps, recheckTolBps },
        });
      }
    }
  }

  const results = configs.map((c) => replay(c.label, c.params, ticks));
  results.sort((a, b) => b.pnl - a.pnl);

  const money = (v: number) => `$${v.toFixed(2)}`;
  const cols = ["Config", "P&L", "Fills", "Parc.", "Abortos", "Capture", "Vol BTC", "Rebal.", "MaxDD"];
  const rows = results.map((r) => [
    r.label,
    money(r.pnl),
    String(r.filled),
    String(r.partial),
    String(r.aborted),
    r.viable ? `${((r.filled / r.viable) * 100).toFixed(0)}%` : "—",
    r.volumeBtc.toFixed(3),
    String(r.rebalances),
    money(r.maxDrawdown),
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((row) => row[i].length)));
  const fmt = (row: string[]) => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join("  ");
  console.log(fmt(cols));
  console.log(widths.map((w) => "─".repeat(w)).join("──"));
  for (const row of rows) console.log(fmt(row));

  console.log(
    "\nNota de honestidad: una cinta es UN régimen de mercado. Los resultados muestran los trade-offs\n" +
      "de cada configuración bajo ese régimen — no una configuración universalmente ganadora.\n" +
      "Para conclusiones robustas, graba varias cintas en horarios distintos y compara.",
  );
}

main();
