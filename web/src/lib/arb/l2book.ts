// Order book L2 completo en tiempo real por WebSocket (lado cliente).
// Mantiene el libro entero (no solo top-of-book) aplicando snapshots + deltas,
// para sizing/slippage con datos de microsegundos en vez de polling REST.
//
// Venues por L2 WS: Bitstamp, Bitfinex, Kraken, Gemini.
// Coinbase queda en REST+ticker (su canal level2 exige autenticación).
// Robustez: si un L2 no está listo o se cae, el dashboard usa el REST como fallback.
import type { Level, OrderBook } from "./types";

/** Mantenedor de un libro L2: precios → cantidad, con snapshot + updates. */
export class L2Book {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  ts = 0;

  snapshot(bids: [number, number][], asks: [number, number][]) {
    this.bids.clear();
    this.asks.clear();
    for (const [p, q] of bids) if (q > 0) this.bids.set(p, q);
    for (const [p, q] of asks) if (q > 0) this.asks.set(p, q);
    this.ts = Date.now();
  }

  update(side: "bid" | "ask", price: number, qty: number) {
    const m = side === "bid" ? this.bids : this.asks;
    if (qty <= 0) m.delete(price);
    else m.set(price, qty);
    this.ts = Date.now();
  }

  get ready() {
    return this.bids.size > 0 && this.asks.size > 0;
  }

  top(n = 25): { bids: Level[]; asks: Level[] } {
    const bids = [...this.bids.entries()]
      .map(([price, qty]) => ({ price, qty }))
      .sort((a, b) => b.price - a.price)
      .slice(0, n);
    const asks = [...this.asks.entries()]
      .map(([price, qty]) => ({ price, qty }))
      .sort((a, b) => a.price - b.price)
      .slice(0, n);
    return { bids, asks };
  }
}

type L2Adapter = {
  exchange: string;
  url: string;
  subscribe: unknown;
  // Aplica el mensaje al libro; devuelve true si lo modificó.
  apply: (msg: unknown, book: L2Book) => boolean;
};

const num = (x: unknown) => Number(x);

const ADAPTERS: L2Adapter[] = [
  {
    exchange: "bitstamp",
    url: "wss://ws.bitstamp.net",
    subscribe: { event: "bts:subscribe", data: { channel: "order_book_btcusd" } },
    apply: (m, book) => {
      const d = m as { event?: string; data?: { bids?: string[][]; asks?: string[][] } };
      if (d.event !== "data" || !d.data?.bids || !d.data?.asks) return false;
      // Bitstamp envía el top-100 completo en cada update → snapshot directo.
      book.snapshot(
        d.data.bids.map((l) => [num(l[0]), num(l[1])]),
        d.data.asks.map((l) => [num(l[0]), num(l[1])]),
      );
      return true;
    },
  },
  {
    exchange: "kraken",
    url: "wss://ws.kraken.com",
    subscribe: { event: "subscribe", pair: ["XBT/USD"], subscription: { name: "book", depth: 25 } },
    apply: (m, book) => {
      if (!Array.isArray(m)) return false;
      let touched = false;
      for (const part of m) {
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;
        const p = part as Record<string, string[][]>;
        if (p.as || p.bs) {
          book.snapshot(
            (p.bs ?? []).map((l) => [num(l[0]), num(l[1])]),
            (p.as ?? []).map((l) => [num(l[0]), num(l[1])]),
          );
          touched = true;
        }
        if (p.a) {
          for (const l of p.a) book.update("ask", num(l[0]), num(l[1]));
          touched = true;
        }
        if (p.b) {
          for (const l of p.b) book.update("bid", num(l[0]), num(l[1]));
          touched = true;
        }
      }
      return touched;
    },
  },
  {
    exchange: "bitfinex",
    url: "wss://api-pub.bitfinex.com/ws/2",
    subscribe: { event: "subscribe", channel: "book", symbol: "tBTCUSD", prec: "P0", len: 25 },
    apply: (m, book) => {
      if (!Array.isArray(m) || m[1] === "hb") return false;
      const payload = m[1];
      if (!Array.isArray(payload)) return false;
      if (Array.isArray(payload[0])) {
        // snapshot: [[price,count,amount],...]
        const bids: [number, number][] = [];
        const asks: [number, number][] = [];
        for (const lvl of payload as number[][]) {
          const [price, count, amount] = lvl;
          if (count > 0) (amount > 0 ? bids : asks).push([price, Math.abs(amount)]);
        }
        book.snapshot(bids, asks);
        return true;
      }
      // update: [price,count,amount]
      const [price, count, amount] = payload as number[];
      if (count === 0) {
        // amount === 1 → quitar bid; amount === -1 → quitar ask
        book.update(amount === 1 ? "bid" : "ask", price, 0);
      } else {
        book.update(amount > 0 ? "bid" : "ask", price, Math.abs(amount));
      }
      return true;
    },
  },
  {
    exchange: "gemini",
    url: "wss://api.gemini.com/v2/marketdata",
    subscribe: { type: "subscribe", subscriptions: [{ name: "l2", symbols: ["BTCUSD"] }] },
    apply: (m, book) => {
      const d = m as { type?: string; changes?: [string, string, string][] };
      if (d.type !== "l2_updates" || !d.changes) return false;
      // El primer l2_updates trae el libro completo; los siguientes son deltas.
      for (const [side, price, qty] of d.changes) {
        book.update(side === "buy" ? "bid" : "ask", num(price), num(qty));
      }
      return true;
    },
  },
];

export type L2Status = "connecting" | "live" | "closed";

/** Gestiona las conexiones L2 WS y expone los libros completos. */
export class L2Feed {
  private books = new Map<string, L2Book>();
  private status = new Map<string, L2Status>();
  private sockets = new Map<string, WebSocket>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private msgTimes = new Map<string, number[]>();
  private closed = false;

  start() {
    if (typeof WebSocket === "undefined") return;
    for (const a of ADAPTERS) {
      this.books.set(a.exchange, new L2Book());
      this.connect(a);
    }
  }

  private connect(a: L2Adapter) {
    if (this.closed) return;
    this.status.set(a.exchange, "connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(a.url);
    } catch {
      this.reconnect(a);
      return;
    }
    this.sockets.set(a.exchange, ws);
    ws.onopen = () => ws.send(JSON.stringify(a.subscribe));
    ws.onmessage = (ev) => {
      const times = this.msgTimes.get(a.exchange) ?? [];
      times.push(Date.now());
      this.msgTimes.set(a.exchange, times);
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      const book = this.books.get(a.exchange);
      if (book && a.apply(parsed, book) && book.ready) this.status.set(a.exchange, "live");
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      this.status.set(a.exchange, "closed");
      this.books.get(a.exchange)?.snapshot([], []); // invalida el libro caído
      this.reconnect(a);
    };
  }

  private reconnect(a: L2Adapter) {
    if (this.closed) return;
    const prev = this.timers.get(a.exchange);
    if (prev) clearTimeout(prev);
    this.timers.set(a.exchange, setTimeout(() => this.connect(a), 3000));
  }

  /** Libros L2 listos como OrderBook[] (solo los que tienen datos). */
  getBooks(): Record<string, OrderBook> {
    const out: Record<string, OrderBook> = {};
    for (const [ex, book] of this.books) {
      if (!book.ready) continue;
      const { bids, asks } = book.top(25);
      out[ex] = { exchange: ex, bids, asks, ts: book.ts, latencyMs: 0, ok: true };
    }
    return out;
  }

  getStatus(): Record<string, L2Status> {
    return Object.fromEntries(this.status);
  }

  getRates(): Record<string, number> {
    const cutoff = Date.now() - 1000;
    const out: Record<string, number> = {};
    for (const [ex, times] of this.msgTimes) {
      const recent = times.filter((t) => t > cutoff);
      this.msgTimes.set(ex, recent);
      out[ex] = recent.length;
    }
    return out;
  }

  close() {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    for (const ws of this.sockets.values()) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    }
  }
}
