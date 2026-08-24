// Descarga historial COMPLETO de funding rates (endpoints públicos, sin API
// key) a JSONL en web/data/funding/. Igual que las cintas del arbitraje: datos
// reales, locales, gitignored, reproducibles.
//
//   pnpm funding:fetch              → desde 2020-01-01 hasta hoy
//   pnpm funding:fetch 2022-06-01   → desde una fecha concreta
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FundingTick } from "../src/lib/funding/types";

const OUT_DIR = join(process.cwd(), "data", "funding");
const FROM = Date.parse(process.argv[2] ?? "2020-01-01T00:00:00Z");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.json();
}

/** Binance USDⓈ-M: ascendente, límite 1000 por llamada, paginado por startTime. */
async function fetchBinance(symbol: string): Promise<FundingTick[]> {
  const out: FundingTick[] = [];
  let start = FROM;
  for (;;) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${start}&limit=1000`;
    const rows = (await getJson(url)) as { fundingTime: number; fundingRate: string; markPrice?: string }[];
    if (!rows.length) break;
    for (const r of rows) {
      const rate = Number(r.fundingRate);
      if (Number.isFinite(rate)) out.push({ t: r.fundingTime, rate, price: Number(r.markPrice) || undefined });
    }
    if (rows.length < 1000) break;
    start = rows[rows.length - 1].fundingTime + 1;
    await sleep(250); // respetar rate limits públicos
  }
  return out;
}

/** Bybit v5: DESCENDENTE, límite 200, paginado hacia atrás con endTime. */
async function fetchBybit(symbol: string): Promise<FundingTick[]> {
  const out: FundingTick[] = [];
  let end = Date.now();
  for (;;) {
    const url = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=200&startTime=${FROM}&endTime=${end}`;
    const json = (await getJson(url)) as {
      retCode: number;
      result?: { list?: { fundingRateTimestamp: string; fundingRate: string }[] };
    };
    if (json.retCode !== 0) throw new Error(`Bybit retCode ${json.retCode}`);
    const rows = json.result?.list ?? [];
    if (!rows.length) break;
    for (const r of rows) {
      const rate = Number(r.fundingRate);
      const t = Number(r.fundingRateTimestamp);
      if (Number.isFinite(rate) && Number.isFinite(t)) out.push({ t, rate });
    }
    const oldest = Number(rows[rows.length - 1].fundingRateTimestamp);
    if (rows.length < 200 || oldest <= FROM) break;
    end = oldest - 1;
    await sleep(250);
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function save(name: string, ticks: FundingTick[]) {
  const file = join(OUT_DIR, `${name}.jsonl`);
  writeFileSync(file, ticks.map((t) => JSON.stringify(t)).join("\n") + "\n");
  const from = new Date(ticks[0].t).toISOString().slice(0, 10);
  const to = new Date(ticks[ticks.length - 1].t).toISOString().slice(0, 10);
  console.log(`  ✔ ${name}: ${ticks.length} periodos (${from} → ${to}) → ${file}`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Descargando funding desde ${new Date(FROM).toISOString().slice(0, 10)}…`);

  const jobs: [string, () => Promise<FundingTick[]>][] = [
    ["binance-BTCUSDT", () => fetchBinance("BTCUSDT")],
    ["binance-ETHUSDT", () => fetchBinance("ETHUSDT")],
    ["bybit-BTCUSDT", () => fetchBybit("BTCUSDT")],
    ["bybit-ETHUSDT", () => fetchBybit("ETHUSDT")],
  ];
  for (const [name, fn] of jobs) {
    try {
      const ticks = await fn();
      if (ticks.length) save(name, ticks);
      else console.log(`  ✖ ${name}: sin datos`);
    } catch (e) {
      console.log(`  ✖ ${name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log("Listo. Corre: pnpm funding:backtest");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
