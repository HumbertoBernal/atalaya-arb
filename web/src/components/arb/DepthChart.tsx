"use client";

// Profundidad del order book (depth chart clásico de trading): liquidez
// acumulada a cada precio. Es la materia prima del cálculo de slippage — el
// motor "camina" exactamente estos niveles al dimensionar una orden.
import { useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EXCHANGE_LABEL } from "@/lib/arb/config";
import { fmtNum, fmtUsd } from "@/lib/arb/format";
import type { OrderBook } from "@/lib/arb/types";

type Point = { price: number; bid?: number; ask?: number };

function buildDepth(book: OrderBook): Point[] {
  const pts: Point[] = [];
  let cum = 0;
  // Bids: del mejor hacia abajo, acumulando (se grafican de izquierda al mid).
  const bids: Point[] = [];
  for (const l of book.bids) {
    cum += l.qty;
    bids.push({ price: l.price, bid: cum });
  }
  bids.reverse();
  pts.push(...bids);
  // Asks: del mejor hacia arriba, acumulando.
  cum = 0;
  for (const l of book.asks) {
    cum += l.qty;
    pts.push({ price: l.price, ask: cum });
  }
  return pts;
}

export function DepthChart({ books }: { books: OrderBook[] }) {
  const usable = books.filter((b) => b.ok && b.bids.length > 2 && b.asks.length > 2);
  const [venue, setVenue] = useState<string | null>(null);
  const active = usable.find((b) => b.exchange === venue) ?? usable[0];
  // buildDepth es barato (≤50 niveles); el React Compiler memoiza el render.
  const data = active ? buildDepth(active) : [];

  if (!active) {
    return <p className="text-sm text-neutral-500">Esperando profundidad de mercado…</p>;
  }

  const mid = (active.bids[0].price + active.asks[0].price) / 2;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {usable.map((b) => (
          <button
            key={b.exchange}
            onClick={() => setVenue(b.exchange)}
            className={`px-2.5 py-1 rounded-full border text-xs transition-colors ${
              b.exchange === active.exchange
                ? "border-cyan-400 bg-cyan-500/15 text-cyan-200"
                : "border-neutral-700 text-neutral-400 hover:border-neutral-500"
            }`}
          >
            {EXCHANGE_LABEL[b.exchange] ?? b.exchange}
          </button>
        ))}
        <span className="ml-auto text-xs text-neutral-500 font-mono">
          mid {fmtUsd(mid)} · {active.bids.length + active.asks.length} niveles
        </span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id="depthBid" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#34d399" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#34d399" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="depthAsk" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fb7185" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#fb7185" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="price"
            type="number"
            domain={["dataMin", "dataMax"]}
            tick={{ fontSize: 10 }}
            stroke="#666"
            tickFormatter={(v) => `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
          />
          <YAxis tick={{ fontSize: 10 }} stroke="#666" width={44} tickFormatter={(v) => `${v}₿`} />
          <Tooltip
            formatter={(v, name) => [`${fmtNum(Number(v), 3)} BTC`, name === "bid" ? "Bids acum." : "Asks acum."]}
            labelFormatter={(v) => fmtUsd(Number(v))}
            contentStyle={{ background: "#15151a", border: "1px solid #26262e", borderRadius: 8, fontSize: 12 }}
          />
          <Area type="stepAfter" dataKey="bid" stroke="#34d399" strokeWidth={1.5} fill="url(#depthBid)" isAnimationActive={false} />
          <Area type="stepAfter" dataKey="ask" stroke="#fb7185" strokeWidth={1.5} fill="url(#depthAsk)" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
