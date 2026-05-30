"use client";

import { useEffect, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { EXCHANGE_LABEL, EXCHANGES } from "@/lib/arb/config";
import { fmtDuration, fmtNum, fmtUsd } from "@/lib/arb/format";
import type { FeedStatus } from "@/lib/arb/livefeed";
import type { OrderBook, Opportunity, Trade, Wallet } from "@/lib/arb/types";
import { SpreadMatrix } from "./SpreadMatrix";
import { FEE_TIERS, useArbEngine } from "./useArbEngine";

// Flash verde/rojo cuando un valor sube/baja (técnica de trading terminals).
function useFlash(value: number) {
  const prev = useRef(value);
  const [dir, setDir] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (value > prev.current) setDir("up");
    else if (value < prev.current) setDir("down");
    prev.current = value;
    const id = setTimeout(() => setDir(null), 400);
    return () => clearTimeout(id);
  }, [value]);
  return dir === "up" ? "flash-up" : dir === "down" ? "flash-down" : "";
}

export function ArbDashboard() {
  const e = useArbEngine();
  const okBooks = e.books.filter((b) => b.ok);
  const viableCount = e.opps.filter((o) => o.viable).length;
  const totalUsd = Object.values(e.wallets).reduce((s, w) => s + w.usd, 0);
  const totalBtc = Object.values(e.wallets).reduce((s, w) => s + w.btc, 0);
  const partialCount = e.trades.filter((t) => t.partial).length;
  const wsLive = Object.values(e.feedStatus).filter((s) => s === "live").length;
  const loading = e.books.length === 0;

  return (
    <main className="min-h-screen text-neutral-100 px-4 md:px-6 py-8">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
              Atalaya <span className="text-cyan-400">· Arbitraje BTC</span>
            </h1>
            <p className="text-neutral-400 text-sm mt-1 max-w-2xl">
              Detección en tiempo real (WebSocket) de divergencias entre exchanges, ejecución simulada neta
              de fees, slippage, latencia y retiros.
            </p>
            <a href="/como-funciona.html" className="inline-block mt-2 text-sm text-cyan-400 hover:text-cyan-300">
              Cómo funciona y la matemática →
            </a>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={e.toggleRunning}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                e.running ? "bg-amber-600 hover:bg-amber-500" : "bg-emerald-600 hover:bg-emerald-500"
              }`}
            >
              {e.running ? "⏸ Pausar" : "▶ Reanudar"}
            </button>
            <button onClick={e.reset} className="px-3 py-2 rounded-lg text-sm font-medium bg-neutral-800 hover:bg-neutral-700 transition-colors">
              ↺ Reset
            </button>
          </div>
        </header>

        {/* Circuit breaker */}
        {e.risk.tripped && (
          <div className="mb-5 rounded-lg border border-rose-700 bg-rose-950/40 p-3 text-sm text-rose-200">
            <strong>🛑 Circuit breaker activo</strong> — ejecución detenida: {e.risk.reasons.join(" · ")}
          </div>
        )}

        {/* Hero: el P&L domina */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="md:col-span-2 rounded-2xl border border-neutral-800 bg-gradient-to-br from-neutral-900 to-neutral-950 p-6">
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">P&L realizado</p>
            <p className={`mt-1 font-mono text-5xl md:text-6xl font-semibold tracking-tight ${e.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
              {fmtUsd(e.pnl)}
            </p>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-neutral-500">
              <span><span className="text-neutral-300 font-mono">{e.trades.length}</span> operaciones · {partialCount} parciales</span>
              <span><span className="text-neutral-300 font-mono">{fmtNum(totalBtc, 2)}</span> BTC inventario</span>
              <span className="capitalize">Modo: {e.makerMode ? "maker" : "taker"} · {FEE_TIERS.find((t) => t.id === e.feeTier)?.label}</span>
            </div>
          </div>
          <div className="rounded-2xl border border-emerald-900/40 bg-emerald-950/20 p-6 flex flex-col justify-center">
            <p className="text-xs uppercase tracking-[0.2em] text-emerald-500/70">Viables ahora</p>
            <p className="font-mono text-4xl md:text-5xl text-emerald-300 mt-1">{viableCount}</p>
            <p className="text-xs text-neutral-500 mt-1">de {e.opps.length} divergencias detectadas</p>
          </div>
        </section>

        {/* Controles */}
        <section className="mb-5 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-neutral-400 inline-flex items-center">
            Tier de fees
            <InfoTip>Simula qué comisión pagas, de retail (~0.4%) a HFT (~0). El mismo spread se vuelve rentable o no según el tier — por eso el arbitraje es un juego de bajo fee / alto volumen.</InfoTip>:
          </span>
          {FEE_TIERS.map((t) => (
            <Toggle key={t.id} active={e.feeTier === t.id} onClick={() => e.setFeeTier(t.id)}>{t.label}</Toggle>
          ))}
          <span className="mx-2 text-neutral-700">|</span>
          <span className="text-neutral-400 inline-flex items-center">
            Ejecución
            <InfoTip>Taker = orden inmediata (fee mayor). Maker = orden límite (fee menor, viable en retail) pero solo se llena ~55% de las veces — modelamos ese riesgo de ejecución.</InfoTip>:
          </span>
          <Toggle active={!e.makerMode} onClick={() => e.setMakerMode(false)}>Taker</Toggle>
          <Toggle active={e.makerMode} onClick={() => e.setMakerMode(true)}>Maker (límite)</Toggle>
        </section>

        {/* Métricas (status strip secundario) */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Metric label="Detección p50" tip="Tiempo de cómputo del motor por tick (mediana)." value={`${e.metrics.detP50.toFixed(2)} ms`} good={e.metrics.detP50 < 1} />
          <Metric label="Detección p99" value={`${e.metrics.detP99.toFixed(2)} ms`} good={e.metrics.detP99 < 3} />
          <Metric label="WS msgs/seg" tip="Mensajes WebSocket procesados por segundo (throughput)." value={`${e.metrics.wsRate}`} good={e.metrics.wsRate > 0} />
          <Metric label="Frescura datos" value={`${e.metrics.freshnessMs} ms`} good={e.metrics.freshnessMs < 1500} />
        </section>

        <SectionHeader n="01" title="En vivo" />
        <div className="grid lg:grid-cols-2 gap-6">
          {/* Mercado en vivo */}
          <Panel title="Mercado en vivo" right={`${wsLive} WS · ${okBooks.length}/${e.books.length} REST`}>
            <div className="space-y-1">
              {loading
                ? Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
                : e.books.map((b) => <BookRow key={b.exchange} book={b} status={e.feedStatus[b.exchange]} />)}
            </div>
          </Panel>

          {/* P&L chart */}
          <Panel title="P&L acumulado">
            <ResponsiveContainer width="100%" height={210}>
              <AreaChart data={e.equity.length > 1 ? e.equity : [{ t: 0, pnl: 0 }, { t: 1, pnl: 0 }]}>
                <defs>
                  <linearGradient id="pnl" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#34d399" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="t" hide />
                <YAxis tick={{ fontSize: 11 }} stroke="#666" tickFormatter={(v) => `$${v.toFixed(0)}`} width={56} />
                <Tooltip formatter={(v) => [fmtUsd(Number(v)), "P&L"]} labelFormatter={() => ""} contentStyle={{ background: "#15151a", border: "1px solid #26262e", borderRadius: 8, fontSize: 12 }} />
                <Area type="monotone" dataKey="pnl" stroke="#34d399" strokeWidth={2} fill="url(#pnl)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>
        </div>

        {/* Oportunidades */}
        <Panel className="mt-6" title="Oportunidades cross-exchange">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-neutral-400 border-b border-neutral-800">
                <tr>
                  <th className="text-left py-2">Comprar → Vender</th>
                  <th className="text-right">Bruto <InfoTip>Spread en puntos básicos (1 bps = 0.01%) antes de costos.</InfoTip></th>
                  <th className="text-right">Vol.</th>
                  <th className="text-right">Fees</th>
                  <th className="text-right">Latencia</th>
                  <th className="text-right">Neto</th>
                  <th className="text-right">Estado</th>
                </tr>
              </thead>
              <tbody>
                {loading && Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i}><td colSpan={7} className="py-2"><div className="h-3 rounded bg-neutral-800 animate-pulse" /></td></tr>
                ))}
                {!loading && e.opps.slice(0, 8).map((o) => (
                  <tr key={`${o.buyEx}-${o.sellEx}`} className="border-b border-neutral-800/40">
                    <td className="py-2">{EXCHANGE_LABEL[o.buyEx]} → {EXCHANGE_LABEL[o.sellEx]}</td>
                    <td className="text-right font-mono">{o.grossBps.toFixed(1)} bps</td>
                    <td className="text-right font-mono">{o.maxQty > 0 ? fmtNum(o.maxQty, 3) : "—"}</td>
                    <td className="text-right font-mono text-neutral-500">{fmtUsd(o.feesCost)}</td>
                    <td className="text-right font-mono text-neutral-500">{fmtUsd(o.latencyCost)}</td>
                    <td className={`text-right font-mono ${o.netProfit > 0 ? "text-emerald-400" : "text-neutral-500"}`}>{fmtUsd(o.netProfit)}</td>
                    <td className="text-right">{o.viable ? <span className="text-emerald-400 text-xs">✓ viable</span> : <span className="text-neutral-500 text-xs">no neto</span>}</td>
                  </tr>
                ))}
                {!loading && e.opps.length === 0 && (
                  <tr><td colSpan={7} className="text-center text-neutral-500 py-4">Mercado eficiente ahora mismo — sin divergencias netas. Prueba el tier VIP/Maker.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <SectionHeader n="02" title="Análisis" className="mt-10" />
        {/* Heatmap */}
        <Panel title="Matriz de spreads" subtitle="neto en bps · compra → vende">
          <p className="text-sm text-neutral-400 mb-3">Verde = oportunidad neta positiva. Las {EXCHANGES.length}×{EXCHANGES.length} combinaciones a la vez.</p>
          <SpreadMatrix opps={e.opps} exchanges={[...EXCHANGES]} />
        </Panel>

        <div className="grid md:grid-cols-2 gap-6 mt-6">
          <Panel title="Arbitraje estadístico">
            <p className="text-sm text-neutral-400 mb-3">Z-score del mayor spread vs su media móvil. |z| alto = spread inusual (mean-reversion).</p>
            <div className="grid grid-cols-3 gap-3 text-center">
              <Cell label="Spread actual" value={`${e.stat.current.toFixed(1)} bps`} />
              <Cell label="Media móvil" value={`${e.stat.mean.toFixed(1)} bps`} />
              <Cell label="Z-score" value={e.stat.z.toFixed(2)} highlight={Math.abs(e.stat.z) > 2} />
            </div>
            {Math.abs(e.stat.z) > 2 && <p className="text-amber-400 text-xs mt-3">⚡ Spread {e.stat.z > 0 ? "inusualmente amplio" : "comprimido"} — posible mean-reversion.</p>}
          </Panel>

          <Panel title="Analítica de sesión">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
              <Stat label="Tiempo activo" value={fmtDuration(Date.now() - (e.session.startTs || Date.now()))} />
              <Stat label="Oportunidades vistas" value={e.session.oppsSeen.toLocaleString()} />
              <Stat label="Viables detectadas" value={e.session.viableSeen.toLocaleString()} />
              <Stat label="Capture rate" value={e.session.viableSeen ? `${((e.trades.length / e.session.viableSeen) * 100).toFixed(0)}%` : "—"} />
              <Stat label="Volumen operado" value={`${fmtNum(e.session.volumeBtc, 3)} BTC`} />
              <Stat label="Mejor operación" value={fmtUsd(e.session.bestTrade)} />
              <Stat label="Rebalanceos" value={`${e.session.rebalances}`} />
            </div>
          </Panel>
        </div>

        {/* Triangular */}
        <Panel className="mt-6" title="Arbitraje triangular" subtitle="Coinbase · USD/BTC/ETH">
          <p className="text-sm text-neutral-400 mb-3">Ciclos intra-exchange sin mover fondos entre plataformas.</p>
          <div className="grid sm:grid-cols-2 gap-3">
            {e.tri
              ? e.tri.results.map((r) => (
                  <div key={r.direction} className="rounded-lg border border-neutral-800 bg-neutral-950/50 p-3">
                    <div className="font-mono text-xs text-neutral-300">{r.direction}</div>
                    <div className="flex items-center justify-between mt-1">
                      <span className={`text-lg font-semibold font-mono ${r.viable ? "text-emerald-400" : "text-rose-400"}`}>{r.netBps.toFixed(1)} bps</span>
                      <span className="text-xs text-neutral-500">{r.viable ? "✓ viable" : "no rentable"}</span>
                    </div>
                  </div>
                ))
              : Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-16 rounded-lg bg-neutral-900 animate-pulse" />)}
          </div>
        </Panel>

        <SectionHeader n="03" title="Ledger" className="mt-10" />
        <div className="grid lg:grid-cols-2 gap-6">
          <Panel title="Operaciones ejecutadas">
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {e.trades.length === 0 && <p className="text-neutral-500 text-sm">Aún sin operaciones netas-positivas.</p>}
              {e.trades.map((t) => (
                <div key={t.id + t.ts} className="row-enter flex items-center justify-between text-xs py-1 border-b border-neutral-800/40">
                  <span className="text-neutral-300">
                    {EXCHANGE_LABEL[t.buyEx]} → {EXCHANGE_LABEL[t.sellEx]}
                    {t.partial && <span className="text-amber-500 ml-1">(parcial)</span>}
                  </span>
                  <span className="font-mono text-neutral-400">{fmtNum(t.qty, 4)} BTC</span>
                  <span className="font-mono text-emerald-400">{fmtUsd(t.netProfit)}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Balances de wallets" subtitle={`${fmtUsd(totalUsd)} + ${fmtNum(totalBtc, 3)} BTC`}>
            <div className="space-y-1">
              {Object.values(e.wallets).map((w) => <WalletRow key={w.exchange} wallet={w} />)}
            </div>
          </Panel>
        </div>

        <p className="text-xs text-neutral-600 mt-8 max-w-3xl">
          Simulación educativa / demo (no opera capital real). Net = bruto − fees − slippage (order book real) −
          adverse selection por latencia − retiro amortizado. Feeds: WebSocket L2 (Kraken/Bitstamp/Bitfinex/Gemini) +
          REST (Coinbase).
        </p>
      </div>
    </main>
  );
}

/* ---------- Componentes presentacionales ---------- */

function Panel({ title, subtitle, right, className = "", children }: {
  title: string; subtitle?: string; right?: string; className?: string; children: React.ReactNode;
}) {
  return (
    <section className={`rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">
          {title}
          {subtitle && <span className="text-neutral-500 text-sm font-normal"> · {subtitle}</span>}
        </h2>
        {right && <span className="text-xs text-neutral-500 font-mono">{right}</span>}
      </div>
      {children}
    </section>
  );
}

function SectionHeader({ n, title, className = "" }: { n: string; title: string; className?: string }) {
  return (
    <div className={`flex items-center gap-3 mb-4 ${className}`}>
      <span className="font-mono text-xs text-cyan-400/70">{n}</span>
      <h2 className="text-sm uppercase tracking-[0.25em] text-neutral-400">{title}</h2>
      <span className="flex-1 h-px bg-neutral-800" />
    </div>
  );
}

function Toggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1.5 rounded-full border text-sm transition-colors ${
        active ? "border-cyan-400 bg-cyan-500/15 text-cyan-200" : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
      }`}
    >
      {children}
    </button>
  );
}

function InfoTip({ children }: { children: React.ReactNode }) {
  return (
    <span className="group relative inline-flex">
      <span tabIndex={0} className="mx-1 inline-grid h-3.5 w-3.5 place-items-center rounded-full border border-neutral-600 text-[9px] text-neutral-400 cursor-help">?</span>
      <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1 w-56 -translate-x-1/2 rounded-lg border border-neutral-700 bg-neutral-900 p-2 text-xs font-normal normal-case tracking-normal text-neutral-300 opacity-0 shadow-xl transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {children}
      </span>
    </span>
  );
}

function BookRow({ book, status }: { book: OrderBook; status?: FeedStatus }) {
  const bid = book.bids[0]?.price ?? 0;
  const ask = book.asks[0]?.price ?? 0;
  const bidFlash = useFlash(bid);
  const askFlash = useFlash(ask);
  const live = status === "live";
  return (
    <div className="flex items-center justify-between text-sm py-1.5 border-b border-neutral-800/50">
      <span className="font-medium w-24 flex items-center gap-1.5">
        {EXCHANGE_LABEL[book.exchange] ?? book.exchange}
        <span className={`w-1.5 h-1.5 rounded-full ${live ? "bg-emerald-400 live-dot" : "bg-neutral-600"}`} title={live ? "WebSocket en vivo" : "REST"} />
      </span>
      {book.ok ? (
        <>
          <span className={`text-emerald-400 font-mono rounded px-1 ${bidFlash}`}>bid {fmtUsd(bid)}</span>
          <span className={`text-rose-400 font-mono rounded px-1 ${askFlash}`}>ask {fmtUsd(ask)}</span>
          <span className="text-neutral-500 text-xs w-16 text-right">{live ? "WS" : `${book.latencyMs}ms`}</span>
        </>
      ) : (
        <span className="text-amber-500 text-xs">offline: {book.error}</span>
      )}
    </div>
  );
}

function WalletRow({ wallet }: { wallet: Wallet }) {
  return (
    <div className="flex items-center justify-between text-sm py-1 border-b border-neutral-800/40">
      <span className="w-24">{EXCHANGE_LABEL[wallet.exchange]}</span>
      <span className="font-mono text-neutral-300">{fmtUsd(wallet.usd)}</span>
      <span className="font-mono text-neutral-400">{fmtNum(wallet.btc, 4)} BTC</span>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-neutral-800/50">
      <div className="h-3 w-20 rounded bg-neutral-800 animate-pulse" />
      <div className="h-3 w-24 rounded bg-neutral-800 animate-pulse" />
      <div className="h-3 w-24 rounded bg-neutral-800 animate-pulse" />
    </div>
  );
}

function Cell({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <p className="text-xs text-neutral-400">{label}</p>
      <p className={`font-mono text-lg ${highlight ? "text-amber-400" : ""}`}>{value}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-neutral-800/40 py-0.5">
      <span className="text-neutral-400">{label}</span>
      <span className="font-mono text-neutral-200">{value}</span>
    </div>
  );
}

function Metric({ label, value, good, tip }: { label: string; value: string; good?: boolean; tip?: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-neutral-400 inline-flex items-center">{label}{tip && <InfoTip>{tip}</InfoTip>}</span>
        <span className={`w-1.5 h-1.5 rounded-full ${good ? "bg-emerald-400" : "bg-neutral-600"}`} />
      </div>
      <p className="font-mono text-base mt-0.5">{value}</p>
    </div>
  );
}
