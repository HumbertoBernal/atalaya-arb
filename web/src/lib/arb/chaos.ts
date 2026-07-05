// Inyector de escenarios adversos (modo caos) — solo capa de simulación.
// Permite DEMOSTRAR la robustez en vivo: tirar un venue, provocar un shock de
// precio, secar la liquidez o congelar los feeds, y ver cómo reaccionan los
// circuit breakers, el fallback y la re-verificación de ejecución.
// Funciones puras sobre los libros ya mezclados; el mercado real no se toca.
import type { OrderBook, OrderBooks } from "./types";

export type ChaosState = {
  offline: Record<string, boolean>; // venue "caído": su libro se marca offline
  liquidityCrunch: boolean; // sequía: las cantidades visibles se desploman
  freezeFeeds: boolean; // congela datos → dispara el breaker de staleness
  shockVenue: string | null; // venue que sufre el shock de precio
  shockBps: number; // magnitud del shock (bps, con signo)
  shockUntil: number; // epoch ms en que expira el shock
};

export const NO_CHAOS: ChaosState = {
  offline: {},
  liquidityCrunch: false,
  freezeFeeds: false,
  shockVenue: null,
  shockBps: 0,
  shockUntil: 0,
};

export function chaosActive(c: ChaosState, now: number): boolean {
  return (
    Object.values(c.offline).some(Boolean) ||
    c.liquidityCrunch ||
    c.freezeFeeds ||
    (c.shockVenue !== null && now < c.shockUntil)
  );
}

/** Factor de sequía: deja ~2% de la liquidez visible. */
const CRUNCH_FACTOR = 0.02;

/** Aplica el estado de caos sobre los libros mezclados (puro, no muta). */
export function applyChaos(
  books: OrderBook[],
  c: ChaosState,
  now: number,
): { merged: OrderBook[]; map: OrderBooks } {
  const merged: OrderBook[] = [];
  const map: OrderBooks = {};

  for (const b of books) {
    let out = b;

    if (c.offline[b.exchange]) {
      out = { ...b, ok: false, error: "caído (modo caos)" };
    } else if (b.ok) {
      let bids = b.bids;
      let asks = b.asks;
      if (c.liquidityCrunch) {
        bids = bids.map((l) => ({ ...l, qty: l.qty * CRUNCH_FACTOR }));
        asks = asks.map((l) => ({ ...l, qty: l.qty * CRUNCH_FACTOR }));
      }
      if (c.shockVenue === b.exchange && now < c.shockUntil) {
        const f = 1 + c.shockBps / 10_000;
        bids = bids.map((l) => ({ ...l, price: l.price * f }));
        asks = asks.map((l) => ({ ...l, price: l.price * f }));
      }
      if (bids !== b.bids || asks !== b.asks) out = { ...b, bids, asks };
    }

    merged.push(out);
    map[out.exchange] = out;
  }

  return { merged, map };
}
