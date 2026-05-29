"use client";

import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MarketPoint } from "@/lib/engine";

export function PriceChart({ data }: { data: MarketPoint[] }) {
  const points = data.map((d) => ({
    date: d.ts.slice(0, 10),
    price: d.price,
  }));

  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={points} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" stopOpacity={0.5} />
            <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={48} stroke="#888" />
        <YAxis
          tick={{ fontSize: 11 }}
          stroke="#888"
          domain={["auto", "auto"]}
          tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
        />
        <Tooltip
          formatter={(v) => [`$${Number(v).toLocaleString()}`, "Precio"]}
          contentStyle={{ background: "#1e1e2e", border: "none", borderRadius: 8, fontSize: 12 }}
        />
        <Area type="monotone" dataKey="price" stroke="#6366f1" strokeWidth={2} fill="url(#g)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
