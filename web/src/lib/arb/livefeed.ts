// Feed en tiempo real vía WebSocket (lado cliente).
// Mantiene el mejor bid/ask por exchange a partir de los feeds públicos, con
// reconexión automática. El dashboard usa esto para detección sub-segundo y
// medición de latencia; la profundidad para sizing sigue viniendo del REST.
//
// Coinbase, Kraken y Bitstamp por WS. Gemini permanece en REST (su feed L2
// requiere mantener el libro completo; se prioriza robustez de la demo).

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
];

export class LiveFeed {
  private sockets = new Map<string, WebSocket>();
  private tops = new Map<string, Top>();
  private status = new Map<string, FeedStatus>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
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
      let parsed: { bid: number; ask: number } | null = null;
      try {
        parsed = a.parse(JSON.parse(ev.data as string));
      } catch {
        return;
      }
      if (parsed && parsed.bid > 0 && parsed.ask > 0) {
        this.tops.set(a.exchange, { ...parsed, ts: Date.now() });
        this.status.set(a.exchange, "live");
      }
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      this.status.set(a.exchange, "closed");
      this.scheduleReconnect(a);
    };
  }

  private scheduleReconnect(a: Adapter) {
    if (this.closed) return;
    const prev = this.timers.get(a.exchange);
    if (prev) clearTimeout(prev);
    this.timers.set(
      a.exchange,
      setTimeout(() => this.connect(a), 3000),
    );
  }

  getTops(): Record<string, Top> {
    return Object.fromEntries(this.tops);
  }

  getStatus(): Record<string, FeedStatus> {
    return Object.fromEntries(this.status);
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
