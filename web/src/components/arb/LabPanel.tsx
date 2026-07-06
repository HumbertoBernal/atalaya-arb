"use client";

// Laboratorio de experimentos: N configuraciones corren EN PARALELO sobre el
// mismo mercado en vivo (mismos libros, mismo caos inyectado), cada una con su
// economía independiente (wallets, breaker, rebalanceos). Responde con
// evidencia a "¿qué configuración funciona?" — y con honestidad: lo que se ve
// son trade-offs bajo el régimen de mercado del momento, no una config mágica.
import { useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtDuration, fmtNum, fmtUsd } from "@/lib/arb/format";
import type { LabConfigId, LabView } from "./useArbEngine";

type Props = {
  lab: LabView;
  nowTs: number;
  startLab: (ids: LabConfigId[]) => void;
  stopLab: () => void;
  clearLab: () => void;
};

const CHOICES: { id: LabConfigId; label: string; color: string; hint: string }[] = [
  { id: "conservador", label: "Conservador", color: "#34d399", hint: "Umbral 5 bps, órdenes chicas, breaker sensible" },
  { id: "balanceado", label: "Balanceado", color: "#22d3ee", hint: "Los defaults del motor" },
  { id: "agresivo", label: "Agresivo", color: "#fbbf24", hint: "Volumen alto, tolerancia amplia" },
  { id: "actual", label: "Tu config actual", color: "#a78bfa", hint: "Snapshot de tus parámetros de este momento" },
];

export function LabPanel({ lab, nowTs, startLab, stopLab, clearLab }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<LabConfigId[]>(["conservador", "balanceado", "agresivo"]);
  const hasRuns = lab.runs.length > 0;

  const toggle = (id: LabConfigId) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <section
      className={`mb-6 rounded-xl border ${
        lab.active ? "border-violet-700/60 bg-violet-950/10" : "border-neutral-800 bg-neutral-900/50"
      }`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-3 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <span className="text-violet-400">🧪</span> Laboratorio
          <span className="text-neutral-500 font-normal">· configs en paralelo sobre el mismo mercado</span>
          {lab.active && (
            <span className="rounded-full border border-violet-700 bg-violet-950/50 px-2 py-0.5 text-[10px] uppercase tracking-wider text-violet-300">
              experimento en curso
            </span>
          )}
        </span>
        <span className="text-neutral-500 text-xs font-mono">{open ? "▲ cerrar" : "▼ abrir"}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4">
          {!hasRuns && (
            <>
              <p className="text-xs text-neutral-500">
                Cada configuración corre como un motor independiente (wallets, breaker y rebalanceos propios)
                sobre exactamente los mismos libros en vivo — incluido lo que inyectes con el modo caos.
                Los presets se aplican sobre tu config actual: mismo tier y venues, solo cambia la estrategia.
              </p>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {CHOICES.map((c) => {
                  const on = selected.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      onClick={() => toggle(c.id)}
                      title={c.hint}
                      className={`px-3 py-1.5 rounded-full border text-sm transition-colors ${
                        on ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:border-neutral-500"
                      }`}
                      style={{ borderColor: on ? c.color : undefined }}
                    >
                      <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: c.color }} />
                      {c.label}
                    </button>
                  );
                })}
                <button
                  onClick={() => startLab(selected)}
                  disabled={selected.length < 2}
                  className="ml-auto px-3 py-1.5 rounded-lg text-sm font-medium bg-violet-700 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  ▶ Iniciar experimento
                </button>
              </div>
              {selected.length < 2 && <p className="text-xs text-amber-500/80">Elige al menos 2 configuraciones para comparar.</p>}
            </>
          )}

          {hasRuns && (
            <>
              <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-400">
                <span className="font-mono">
                  {lab.active ? "⏱" : "⏸"} {nowTs && lab.startTs ? fmtDuration(nowTs - lab.startTs) : "—"} · {lab.ticks} ticks
                </span>
                {lab.active ? (
                  <button onClick={stopLab} className="px-2.5 py-1 rounded-lg border border-neutral-700 text-neutral-300 hover:border-amber-500 hover:text-amber-300 transition-colors">
                    ⏹ Detener (congela resultados)
                  </button>
                ) : (
                  <span className="text-amber-400/90">resultados congelados</span>
                )}
                <button onClick={clearLab} className="px-2.5 py-1 rounded-lg border border-neutral-700 text-neutral-300 hover:border-neutral-500 transition-colors">
                  ↺ Nuevo experimento
                </button>
              </div>

              {/* Tabla comparativa */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-neutral-400 border-b border-neutral-800">
                    <tr>
                      <th className="text-left py-2">Config</th>
                      <th className="text-right">P&L</th>
                      <th className="text-right">Fills</th>
                      <th className="text-right">Abortos</th>
                      <th className="text-right">Capture</th>
                      <th className="text-right">Vol. BTC</th>
                      <th className="text-right">Rebal.</th>
                      <th className="text-right">Breaker</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...lab.runs]
                      .sort((a, b) => b.pnl - a.pnl)
                      .map((r, i) => (
                        <tr key={r.id} className="border-b border-neutral-800/40">
                          <td className="py-2">
                            <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: r.color }} />
                            {r.label}
                            {i === 0 && lab.ticks > 10 && <span className="ml-2 text-xs text-neutral-500">👑</span>}
                          </td>
                          <td className={`text-right font-mono ${r.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtUsd(r.pnl)}</td>
                          <td className="text-right font-mono">{r.filled}</td>
                          <td className="text-right font-mono text-amber-400/90">{r.aborted}</td>
                          <td className="text-right font-mono text-neutral-400">
                            {r.viableSeen ? `${((r.filled / r.viableSeen) * 100).toFixed(0)}%` : "—"}
                          </td>
                          <td className="text-right font-mono text-neutral-400">{fmtNum(r.volumeBtc, 3)}</td>
                          <td className="text-right font-mono text-neutral-400">{r.rebalances}</td>
                          <td className="text-right">
                            {r.breaker === "ok" && <span className="text-emerald-400 text-xs">● ok</span>}
                            {r.breaker === "cooldown" && <span className="text-amber-400 text-xs">◐ cooldown</span>}
                            {r.breaker === "halt" && <span className="text-rose-400 text-xs">■ halt</span>}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>

              {/* P&L comparado */}
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={lab.series.length > 1 ? lab.series : [{ t: 0 }, { t: 1 }]}>
                  <XAxis dataKey="t" hide />
                  <YAxis tick={{ fontSize: 10 }} stroke="#666" width={56} tickFormatter={(v) => `$${Number(v).toFixed(0)}`} />
                  <Tooltip
                    formatter={(v, name) => [fmtUsd(Number(v)), CHOICES.find((c) => c.id === name)?.label ?? String(name)]}
                    labelFormatter={() => ""}
                    contentStyle={{ background: "#15151a", border: "1px solid #26262e", borderRadius: 8, fontSize: 12 }}
                  />
                  {lab.runs.map((r) => (
                    <Line key={r.id} type="monotone" dataKey={r.id} stroke={r.color} strokeWidth={1.8} dot={false} isAnimationActive={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </>
          )}

          <p className="text-xs text-neutral-600">
            Honestidad estadística: corridas cortas son ruido — qué config &laquo;gana&raquo; depende del régimen de
            mercado del momento. El experimento muestra <strong className="text-neutral-400">trade-offs</strong>
            (más tolerancia = más fills pero peores; más umbral = menos operaciones pero más limpias), no una
            configuración mágica. Deja correr ≥15 min para señales más estables, o usa{" "}
            <code className="text-neutral-400">pnpm tape && pnpm experiment</code> para un barrido reproducible
            sobre una cinta grabada.
          </p>
        </div>
      )}
    </section>
  );
}
