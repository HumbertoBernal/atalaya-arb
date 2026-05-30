"use client";

import { EXCHANGE_LABEL } from "@/lib/arb/config";
import type { Opportunity } from "@/lib/arb/types";

// Heatmap fila (compra) × columna (venta): margen NETO en bps, coloreado.
export function SpreadMatrix({ opps, exchanges }: { opps: Opportunity[]; exchanges: string[] }) {
  const key = (b: string, s: string) => `${b}→${s}`;
  const map = new Map<string, Opportunity>();
  for (const o of opps) map.set(key(o.buyEx, o.sellEx), o);

  const color = (bps: number | null) => {
    if (bps === null) return "bg-neutral-900 text-neutral-700";
    if (bps > 1) return "bg-emerald-500/30 text-emerald-300";
    if (bps > 0) return "bg-emerald-500/10 text-emerald-400/80";
    if (bps > -3) return "bg-rose-500/10 text-rose-400/70";
    return "bg-rose-500/20 text-rose-300/80";
  };

  return (
    <div className="overflow-x-auto">
      <table className="text-xs border-separate" style={{ borderSpacing: 3 }}>
        <thead>
          <tr>
            <th className="text-neutral-500 font-normal p-1 text-left">compra ↓ / vende →</th>
            {exchanges.map((s) => (
              <th key={s} className="text-neutral-400 font-medium p-1">{EXCHANGE_LABEL[s] ?? s}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {exchanges.map((b) => (
            <tr key={b}>
              <td className="text-neutral-400 font-medium p-1 text-right">{EXCHANGE_LABEL[b] ?? b}</td>
              {exchanges.map((s) => {
                if (b === s) return <td key={s} className="p-1 rounded bg-neutral-950 text-neutral-700 text-center font-mono">—</td>;
                const o = map.get(key(b, s));
                const bps = o ? o.netBps : null;
                return (
                  <td key={s} className={`p-1 rounded text-center font-mono ${color(bps)}`} title={o ? `neto ${o.netProfit.toFixed(2)} USD` : ""}>
                    {bps === null ? "·" : bps.toFixed(1)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
