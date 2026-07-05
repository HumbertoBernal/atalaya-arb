// Feed en tiempo real vía WebSocket (lado cliente): TOP-OF-BOOK (ticker).
// Mantiene el mejor bid/ask por exchange con reconexión automática (backoff
// exponencial + jitter). Complementa a L2Feed (l2book.ts), que mantiene el
// libro COMPLETO por WS para Bitstamp/Kraken/Bitfinex/Gemini; Coinbase queda
// en ticker WS + REST porque su canal level2 exige autenticación.

export type Top = { bid: number; ask: number; ts: number };
export type FeedStatus = "connecting" | "live" | "closed";

type Adapter = {
  exchange: string;
  url: string;
  subscribe: unknown;
  parse: (msg: unknown) => { bid: number; ask: number } | null;
};

const ADAPTERS: Adapter[] = [
  {
    exchange: "coinbase",
    url: "wss://ws-feed.exchange.coinbase.com",
    subscribe: { type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker"] },
    parse: (m) => {
      const d = m as { type?: string; best_bid?: string; best_ask?: string };
      if (d.type === "ticker" && d.best_bid && d.best_ask)
        return { bid: Number(d.best_bid), ask: Number(d.best_ask) };
      return null;
    },
  },
  {
    exchange: "kraken",
    url: "wss://ws.kraken.com",
    subscribe: { event: "subscribe", pair: ["XBT/USD"], subscription: { name: "ticker" } },
    parse: (m) => {
      // [channelID, {b:[bid,...], a:[ask,...]}, "ticker", "XBT/USD"]
      if (!Array.isArray(m) || m.length < 4 || m[2] !== "ticker") return null;
      const t = m[1] as { b?: string[]; a?: string[] };
      if (t?.b?.[0] && t?.a?.[0]) return { bid: Number(t.b[0]), ask: Number(t.a[0]) };
      return null;
    },
  },
  {
    exchange: "bitstamp",
    url: "wss://ws.bitstamp.net",
    subscribe: { event: "bts:subscribe", data: { channel: "order_book_btcusd" } },
    parse: (m) => {
      const d = m as { event?: string; data?: { bids?: string[][]; asks?: string[][] } };
      if (d.event === "data" && d.data?.bids?.[0] && d.data?.asks?.[0])
        return { bid: Number(d.data.bids[0][0]), ask: Number(d.data.asks[0][0]) };
      return null;
    },
  },
  {
    exchange: "bitfinex",
    url: "wss://api-pub.bitfinex.com/ws/2",
    subscribe: { event: "subscribe", channel: "ticker", symbol: "tBTCUSD" },
    parse: (m) => {
      // [CHAN_ID, [BID, BID_SIZE, ASK, ASK_SIZE, ...]]
      if (!Array.isArray(m) || !Array.isArray(m[1]) || m[1].length < 4) return null;
      const t = m[1] as number[];
      if (t[0] > 0 && t[2] > 0) return { bid: t[0], ask: t[2] };
      return null;
    },
  },
];

export class LiveFeed {
  private sockets = new Map<string, WebSocket>();
  private tops = new Map<string, Top>();
  private status = new Map<string, FeedStatus>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private msgTimes = new Map<string, number[]>(); // timestamps recientes por exchange
  private attempts = new Map<string, number>(); // reintentos seguidos (para backoff)
  private closed = false;

  start() {
    if (typeof WebSocket === "undefined") return;
    for (const a of ADAPTERS) this.connect(a);
  }

  private connect(a: Adapter) {
    if (this.closed) return;
    this.status.set(a.exchange, "connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(a.url);
    } catch {
      this.scheduleReconnect(a);
      return;
    }
    this.sockets.set(a.exchange, ws);

    ws.onopen = () => ws.send(JSON.stringify(a.subscribe));
    ws.onmessage = (ev) => {
      // Throughput: cada mensaje recibido cuenta como evento procesado.
      const times = this.msgTimes.get(a.exchange) ?? [];
      times.push(Date.now());
      this.msgTimes.set(a.exchange, times);

      let parsed: { bid: number; ask: number } | null = null;
      try {
        parsed = a.parse(JSON.parse(ev.data as string));
      } catch {
        return;
      }
      if (parsed && parsed.bid > 0 && parsed.ask > 0) {
        this.tops.set(a.exchange, { ...parsed, ts: Date.now() });
        this.status.set(a.exchange, "live");
        this.attempts.set(a.exchange, 0); // conexión sana → backoff se reinicia
      }
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      this.status.set(a.exchange, "closed");
      this.scheduleReconnect(a);
    };
  }

  // Backoff exponencial con jitter: 3s, 6s, 12s… hasta 60s, ±20% aleatorio.
  // Evita martillar un venue caído y que todos los clientes reintenten en fase.
  private scheduleReconnect(a: Adapter) {
    if (this.closed) return;
    const n = this.attempts.get(a.exchange) ?? 0;
    this.attempts.set(a.exchange, n + 1);
    const base = Math.min(60_000, 3000 * 2 ** n);
    const delay = base * (0.8 + Math.random() * 0.4);
    const prev = this.timers.get(a.exchange);
    if (prev) clearTimeout(prev);
    this.timers.set(
      a.exchange,
      setTimeout(() => this.connect(a), delay),
    );
  }

  getTops(): Record<string, Top> {
    return Object.fromEntries(this.tops);
  }

  getStatus(): Record<string, FeedStatus> {
    return Object.fromEntries(this.status);
  }

  /** Mensajes WS por segundo, por exchange (ventana de 1s). */
  getRates(): Record<string, number> {
    const cutoff = Date.now() - 1000;
    const out: Record<string, number> = {};
    for (const [ex, times] of this.msgTimes) {
      const recent = times.filter((t) => t > cutoff);
      this.msgTimes.set(ex, recent); // trim
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
