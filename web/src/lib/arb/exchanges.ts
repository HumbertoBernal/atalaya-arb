// Conectores a order books públicos (server-side: evita CORS y bloqueos geo).
// Cada conector devuelve un OrderBook normalizado: bids desc, asks asc, números.
import type { Level, OrderBook } from "./types";

const UA = "Atalaya-Arb/1.0 (+https://github.com)";
const TIMEOUT = 4000;
const DEPTH = 25;

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const sortBook = (bids: Level[], asks: Level[]): { bids: Level[]; asks: Level[] } => ({
  bids: bids.filter((l) => l.qty > 0).sort((a, b) => b.price - a.price),
  asks: asks.filter((l) => l.qty > 0).sort((a, b) => a.price - b.price),
});

type RawPair = [string | number, string | number, ...unknown[]];
const toLevels = (rows: RawPair[]): Level[] =>
  rows.map((r) => ({ price: Number(r[0]), qty: Number(r[1]) }));

async function wrap(exchange: string, fn: () => Promise<{ bids: Level[]; asks: Level[] }>): Promise<OrderBook> {
  const start = Date.now();
  try {
    const { bids, asks } = await fn();
    const sorted = sortBook(bids, asks);
    return { exchange, ...sorted, ts: Date.now(), latencyMs: Date.now() - start, ok: true };
  } catch (e) {
    return {
      exchange,
      bids: [],
      asks: [],
      ts: Date.now(),
      latencyMs: Date.now() - start,
      ok: false,
      error: e instanceof Error ? e.message : "error",
    };
  }
}

export const fetchCoinbase = () =>
  wrap("coinbase", async () => {
    const d = (await fetchJson(
      "https://api.exchange.coinbase.com/products/BTC-USD/book?level=2",
    )) as { bids: RawPair[]; asks: RawPair[] };
    return { bids: toLevels(d.bids).slice(0, DEPTH), asks: toLevels(d.asks).slice(0, DEPTH) };
  });

export const fetchKraken = () =>
  wrap("kraken", async () => {
    const d = (await fetchJson(`https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=${DEPTH}`)) as {
      result: Record<string, { bids: RawPair[]; asks: RawPair[] }>;
    };
    const key = Object.keys(d.result)[0];
    const book = d.result[key];
    return { bids: toLevels(book.bids), asks: toLevels(book.asks) };
  });

export const fetchBitstamp = () =>
  wrap("bitstamp", async () => {
    const d = (await fetchJson("https://www.bitstamp.net/api/v2/order_book/btcusd/")) as {
      bids: RawPair[];
      asks: RawPair[];
    };
    return { bids: toLevels(d.bids).slice(0, DEPTH), asks: toLevels(d.asks).slice(0, DEPTH) };
  });

export const fetchGemini = () =>
  wrap("gemini", async () => {
    const d = (await fetchJson(
      `https://api.gemini.com/v1/book/btcusd?limit_bids=${DEPTH}&limit_asks=${DEPTH}`,
    )) as { bids: { price: string; amount: string }[]; asks: { price: string; amount: string }[] };
    return {
      bids: d.bids.map((l) => ({ price: Number(l.price), qty: Number(l.amount) })),
      asks: d.asks.map((l) => ({ price: Number(l.price), qty: Number(l.amount) })),
    };
  });

export const fetchBitfinex = () =>
  wrap("bitfinex", async () => {
    // [[price, count, amount], ...]; amount>0 = bid, amount<0 = ask.
    const rows = (await fetchJson(`https://api-pub.bitfinex.com/v2/book/tBTCUSD/P0?len=${DEPTH}`)) as number[][];
    const bids: Level[] = [];
    const asks: Level[] = [];
    for (const [price, , amount] of rows) {
      if (amount > 0) bids.push({ price, qty: amount });
      else if (amount < 0) asks.push({ price, qty: -amount });
    }
    return { bids, asks };
  });

const FETCHERS = [fetchCoinbase, fetchKraken, fetchBitstamp, fetchGemini, fetchBitfinex];

/** Trae todos los order books en paralelo (latencia = la del más lento). */
export async function fetchAllBooks(): Promise<OrderBook[]> {
  return Promise.all(FETCHERS.map((f) => f()));
}
