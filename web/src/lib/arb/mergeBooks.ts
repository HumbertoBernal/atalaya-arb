// Mezcla de fuentes de order book: L2 (WebSocket) preferido, REST como fallback.
// Funciones puras → testeables, sin React.
import { L2_FRESHNESS_MS } from "./config";
import type { OrderBook, OrderBooks } from "./types";

type Top = { bid: number; ask: number; ts: number };

/**
 * Superpone el top-of-book de WS (más fresco) sobre la profundidad del REST,
 * con guardia de monotonicidad para no romper el libro.
 */
export function overlayWs(book: OrderBook, top?: Top): OrderBook {
  if (!book.ok || !top || top.ts <= book.ts || !book.bids.length || !book.asks.length) return book;
  const bids = [...book.bids];
  const asks = [...book.asks];
  if (!bids[1] || top.bid >= bids[1].price) bids[0] = { price: top.bid, qty: bids[0].qty };
  if (!asks[1] || top.ask <= asks[1].price) asks[0] = { price: top.ask, qty: asks[0].qty };
  return { ...book, bids, asks, ts: top.ts, latencyMs: 0 };
}

/** ¿El libro L2 es usable? Fresco, con niveles y no cruzado (bid < ask). */
export function isL2Valid(l2: OrderBook | undefined, now: number): l2 is OrderBook {
  return (
    !!l2 &&
    l2.bids.length > 0 &&
    l2.asks.length > 0 &&
    now - l2.ts < L2_FRESHNESS_MS &&
    l2.bids[0].price < l2.asks[0].price
  );
}

/**
 * Combina REST + L2 + tops de WS en un solo conjunto de libros.
 * Prefiere el L2 (profundidad en tiempo real) cuando es válido; si no, REST con overlay.
 */
export function mergeBooks(
  restBooks: OrderBook[],
  l2books: Record<string, OrderBook>,
  tops: Record<string, Top>,
  now: number,
): { map: OrderBooks; merged: OrderBook[] } {
  const map: OrderBooks = {};
  const merged: OrderBook[] = [];
  for (const b of restBooks) {
    const l2 = l2books[b.exchange];
    const m = isL2Valid(l2, now) ? { ...l2, latencyMs: 0 } : overlayWs(b, tops[b.exchange]);
    map[b.exchange] = m;
    merged.push(m);
  }
  return { map, merged };
}

/** Precio de referencia de BTC (mid del primer libro válido). */
export function referencePrice(books: OrderBook[]): number {
  const ok = books.find((b) => b.ok && b.bids.length && b.asks.length);
  return ok ? (ok.bids[0].price + ok.asks[0].price) / 2 : 0;
}

/** Percentil p (0–100) de un arreglo. */
export function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
