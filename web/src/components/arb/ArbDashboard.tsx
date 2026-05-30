"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { EXCHANGE_LABEL, EXCHANGES, INITIAL_BTC, INITIAL_USD, TAKER_FEE } from "@/lib/arb/config";
import { detectOpportunities, simulateExecution } from "@/lib/arb/engine";
import { LiveFeed, type FeedStatus } from "@/lib/arb/livefeed";
import { evaluateRisk, sanitizeOpportunities, type RiskState } from "@/lib/arb/risk";
import { needsRebalance, rebalance } from "@/lib/arb/rebalance";
import { pushCapped, zScore, type ZScore } from "@/lib/arb/stats";
import { detectTriangular, type TriBooks, type TriResult } from "@/lib/arb/triangular";
import type { OrderBook, OrderBooks, Opportunity, Trade, Wallet } from "@/lib/arb/types";
import { SpreadMatrix } from "./SpreadMatrix";

const POLL_MS = 1200;
const FEE_TIERS = [
  { id: "retail", label: "Retail", mult: 1 },
  { id: "pro", label: "Pro", mult: 0.4 },
  { id: "vip", label: "VIP / HFT", mult: 0.1 },
  { id: "maker", label: "Maker 0%", mult: 0 },
] as const;

function initWallets(): Record<string, Wallet> {
  const w: Record<string, Wallet> = {};
  for (const ex of Object.keys(TAKER_FEE)) w[ex] = { exchange: ex, usd: INITIAL_USD, btc: INITIAL_BTC };
  return w;
}

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtNum = (n: number, d = 4) => n.toLocaleString("en-US", { maximumFractionDigits: d });

function pctile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m ${s % 60}s`;
}

// Mezcla el top-of-book de WS (más fresco) sobre la profundidad del REST,
// con guardia de monotonicidad para no romper el order book.
function overlayWs(book: OrderBook, top?: { bid: number; ask: number; ts: number }): OrderBook {
  if (!book.ok || !top || top.ts <= book.ts || !book.bids.length || !book.asks.length) return book;
  const bids = [...book.bids];
  const asks = [...book.asks];
  if (!bids[1] || top.bid >= bids[1].price) bids[0] = { price: top.bid, qty: bids[0].qty };
  if (!asks[1] || top.ask <= asks[1].price) asks[0] = { price: top.ask, qty: asks[0].qty };
  return { ...book, bids, asks, ts: top.ts, latencyMs: 0 };
}

export function ArbDashboard() {
  const [books, setBooks] = useState<OrderBook[]>([]);
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [wallets, setWallets] = useState<Record<string, Wallet>>(initWallets);
  const [pnl, setPnl] = useState(0);
  const [equity, setEquity] = useState<{ t: number; pnl: number }[]>([]);
  const [running, setRunning] = useState(true);
  const [feeTier, setFeeTier] = useState<(typeof FEE_TIERS)[number]["id"]>("vip");
  const [serverLatency, setServerLatency] = useState(0);
  const [tickCount, setTickCount] = useState(0);
  const [feedStatus, setFeedStatus] = useState<Record<string, FeedStatus>>({});
  const [risk, setRisk] = useState<RiskState>({ tripped: false, reasons: [], maxBookAgeMs: 0 });
  const [tri, setTri] = useState<{ results: TriResult[]; ts: number } | null>(null);
  const [metrics, setMetrics] = useState({ detP50: 0, detP99: 0, wsRate: 0, freshnessMs: 0 });
  const detTimesRef = useRef<number[]>([]);
  const [stat, setStat] = useState<ZScore & { current: number }>({ mean: 0, std: 0, z: 0, n: 0, current: 0 });
  const spreadHistRef = useRef<number[]>([]);
  const [session, setSession] = useState({ oppsSeen: 0, viableSeen: 0, volumeBtc: 0, bestTrade: 0, rebalances: 0, startTs: 0 });
  const sessionRef = useRef({ oppsSeen: 0, viableSeen: 0, volumeBtc: 0, bestTrade: 0, rebalances: 0, startTs: 0 });

  const walletsRef = useRef(wallets);
  const pnlRef = useRef(pnl);
  const peakPnlRef = useRef(0);
  const runningRef = useRef(running);
  const feeRef = useRef(feeTier);
  const feedRef = useRef<LiveFeed | null>(null);
  walletsRef.current = wallets;
  pnlRef.current = pnl;
  runningRef.current = running;
  feeRef.current = feeTier;

  // Arranca el feed WebSocket una vez.
  useEffect(() => {
    const feed = new LiveFeed();
    feed.start();
    feedRef.current = feed;
    sessionRef.current.startTs = Date.now();
    setSession({ ...sessionRef.current });
    return () => feed.close();
  }, []);

  const tick = useCallback(async () => {
    const mult = FEE_TIERS.find((t) => t.id === feeRef.current)?.mult ?? 1;

    // 1) REST: profundidad. 2) overlay top-of-book de WS (fresco).
    let payload: { books: OrderBook[]; serverLatencyMs: number };
    try {
      const res = await fetch("/api/orderbooks", { cache: "no-store" });
      payload = await res.json();
    } catch {
      return;
    }
    const tops = feedRef.current?.getTops() ?? {};
    const map: OrderBooks = {};
    const merged: OrderBook[] = [];
    for (const b of payload.books) {
      const m = overlayWs(b, tops[b.exchange]);
      map[b.exchange] = m;
      merged.push(m);
    }
    setBooks(merged);
    setServerLatency(payload.serverLatencyMs);
    setFeedStatus(feedRef.current?.getStatus() ?? {});
    setTickCount((c) => c + 1);

    const t0 = performance.now();
    const detectedRaw = detectOpportunities(map, mult);
    const detMs = performance.now() - t0;
    const detected = sanitizeOpportunities(detectedRaw);
    setOpps(detected);

    // Métricas de latencia/throughput
    const buf = detTimesRef.current;
    buf.push(detMs);
    if (buf.length > 100) buf.shift();
    const rates = feedRef.current?.getRates() ?? {};
    const wsRate = Object.values(rates).reduce((a, b) => a + b, 0);
    const liveAges = merged.filter((b) => b.ok).map((b) => Date.now() - b.ts);
    setMetrics({
      detP50: pctile(buf, 50),
      detP99: pctile(buf, 99),
      wsRate,
      freshnessMs: liveAges.length ? Math.min(...liveAges) : 0,
    });

    // Arbitraje estadístico: z-score del mayor spread bruto sobre ventana móvil.
    const maxGross = detectedRaw.length ? Math.max(...detectedRaw.map((o) => o.grossBps)) : 0;
    spreadHistRef.current = pushCapped(spreadHistRef.current, maxGross, 120);
    setStat({ ...zScore(spreadHistRef.current), current: maxGross });

    // Analítica de sesión: oportunidades vistas.
    const s = sessionRef.current;
    s.oppsSeen += detectedRaw.length;
    s.viableSeen += detected.filter((o) => o.viable).length;

    // 3) Circuit breaker
    const r = evaluateRisk(merged, detectedRaw, pnlRef.current, peakPnlRef.current, Date.now());
    setRisk(r);

    // 4) Ejecución (solo si corre y el breaker no está disparado)
    if (runningRef.current && !r.tripped) {
      let w = walletsRef.current;
      const newTrades: Trade[] = [];
      let gained = 0;
      for (const opp of detected.filter((o) => o.viable)) {
        const { trade, wallets: nextW } = simulateExecution(opp, map, w, mult);
        if (trade) {
          w = nextW;
          newTrades.push(trade);
          gained += trade.netProfit;
        }
      }

      // Rebalanceo de inventario si algún venue se agotó (paga fees de red).
      let rebalanceCost = 0;
      const okB = merged.find((b) => b.ok && b.bids.length && b.asks.length);
      const refP = okB ? (okB.bids[0].price + okB.asks[0].price) / 2 : 0;
      if (refP && needsRebalance(w)) {
        const rb = rebalance(w, refP);
        w = rb.wallets;
        rebalanceCost = rb.costUsd;
        s.rebalances += 1;
      }

      if (newTrades.length || rebalanceCost > 0) {
        setWallets(w);
        const newPnl = pnlRef.current + gained - rebalanceCost;
        setPnl(newPnl);
        peakPnlRef.current = Math.max(peakPnlRef.current, newPnl);
        if (newTrades.length) {
          setTrades((prev) => [...newTrades.reverse(), ...prev].slice(0, 60));
          for (const tr of newTrades) {
            s.volumeBtc += tr.qty;
            s.bestTrade = Math.max(s.bestTrade, tr.netProfit);
          }
        }
      }
    }
    setSession({ ...s });
    setEquity((prev) => [...prev, { t: Date.now(), pnl: pnlRef.current }].slice(-150));
  }, []);

  useEffect(() => {
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [tick]);

  // Poll del triangular (Coinbase, 3 pares).
  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const res = await fetch("/api/triangular", { cache: "no-store" });
        const d = await res.json();
        if (!alive || !d.ok) return;
        const mult = FEE_TIERS.find((t) => t.id === feeRef.current)?.mult ?? 1;
        const fee = (TAKER_FEE.coinbase ?? 0.006) * mult;
        setTri({ results: detectTriangular(d.books as TriBooks, fee), ts: d.ts });
      } catch {
        /* noop */
      }
    };
    run();
    const id = setInterval(run, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const reset = () => {
    setWallets(initWallets());
    setTrades([]);
    setPnl(0);
    peakPnlRef.current = 0;
    setEquity([]);
    setTickCount(0);
    sessionRef.current = { oppsSeen: 0, viableSeen: 0, volumeBtc: 0, bestTrade: 0, rebalances: 0, startTs: Date.now() };
    setSession({ ...sessionRef.current });
    spreadHistRef.current = [];
  };

  const okBooks = books.filter((b) => b.ok);
  const viableCount = opps.filter((o) => o.viable).length;
  const totalUsd = Object.values(wallets).reduce((s, w) => s + w.usd, 0);
  const totalBtc = Object.values(wallets).reduce((s, w) => s + w.btc, 0);
  const partialCount = trades.filter((t) => t.partial).length;
  const wsLive = Object.values(feedStatus).filter((s) => s === "live").length;

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 px-4 md:px-6 py-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
              Atalaya <span className="text-indigo-400">· Arbitraje BTC</span>
            </h1>
            <p className="text-neutral-400 text-sm mt-1">
              Detección en tiempo real (WebSocket) de divergencias entre exchanges, ejecución simulada neta
              de fees, slippage, latencia y retiros.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setRunning((r) => !r)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
                running ? "bg-amber-600 hover:bg-amber-500" : "bg-emerald-600 hover:bg-emerald-500"
              }`}
            >
              {running ? "⏸ Pausar" : "▶ Reanudar"}
            </button>
            <button onClick={reset} className="px-3 py-1.5 rounded-lg text-sm font-medium bg-neutral-800 hover:bg-neutral-700">
              ↺ Reset
            </button>
          </div>
        </header>

        {/* Circuit breaker */}
        {risk.tripped && (
          <div className="mb-5 rounded-lg border border-rose-700 bg-rose-950/40 p-3 text-sm text-rose-200">
            <strong>🛑 Circuit breaker activo</strong> — ejecución detenida: {risk.reasons.join(" · ")}
          </div>
        )}

        {/* KPIs */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Kpi label="P&L realizado" value={fmtUsd(pnl)} accent={pnl >= 0} big />
          <Kpi label="Operaciones" value={`${trades.length}`} sub={`${partialCount} parciales`} />
          <Kpi label="Oportunidades viables" value={`${viableCount}`} sub={`de ${opps.length} detectadas`} />
          <Kpi label="Feeds" value={`${wsLive} WS · ${okBooks.length}/${books.length} REST`} sub={`${serverLatency}ms · tick #${tickCount}`} />
        </section>

        {/* Control de fees */}
        <section className="mb-6 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-neutral-400">Tier de fees:</span>
          {FEE_TIERS.map((t) => (
            <button
              key={t.id}
              onClick={() => setFeeTier(t.id)}
              className={`px-2.5 py-1 rounded-full border ${
                feeTier === t.id
                  ? "border-indigo-400 bg-indigo-500/20 text-indigo-200"
                  : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
              }`}
            >
              {t.label}
            </button>
          ))}
          <span className="text-neutral-500 text-xs ml-1">
            Con fees retail el arbitraje BTC/USD rara vez es neto-positivo (mercados eficientes); a fees HFT aparecen ejecuciones.
          </span>
        </section>

        {/* Métricas de rendimiento */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Metric label="Detección p50" value={`${metrics.detP50.toFixed(2)} ms`} good={metrics.detP50 < 1} />
          <Metric label="Detección p99" value={`${metrics.detP99.toFixed(2)} ms`} good={metrics.detP99 < 3} />
          <Metric label="WS msgs/seg" value={`${metrics.wsRate}`} good={metrics.wsRate > 0} />
          <Metric label="Frescura datos" value={`${metrics.freshnessMs} ms`} good={metrics.freshnessMs < 1500} />
        </section>

        <div className="grid lg:grid-cols-2 gap-6">
          {/* Order books */}
          <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
            <h2 className="text-lg font-semibold mb-3">Mercado en vivo</h2>
            <div className="space-y-2">
              {books.map((b) => (
                <div key={b.exchange} className="flex items-center justify-between text-sm py-1.5 border-b border-neutral-800/50">
                  <span className="font-medium w-24 flex items-center gap-1.5">
                    {EXCHANGE_LABEL[b.exchange] ?? b.exchange}
                    {feedStatus[b.exchange] === "live" ? (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" title="WebSocket en vivo" />
                    ) : (
                      <span className="w-1.5 h-1.5 rounded-full bg-neutral-600" title="REST" />
                    )}
                  </span>
                  {b.ok ? (
                    <>
                      <span className="text-emerald-400 font-mono">bid {fmtUsd(b.bids[0]?.price ?? 0)}</span>
                      <span className="text-rose-400 font-mono">ask {fmtUsd(b.asks[0]?.price ?? 0)}</span>
                      <span className="text-neutral-500 text-xs w-20 text-right">
                        {feedStatus[b.exchange] === "live" ? "WS" : `${b.latencyMs}ms`}
                      </span>
                    </>
                  ) : (
                    <span className="text-amber-500 text-xs">offline: {b.error}</span>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* P&L chart */}
          <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
            <h2 className="text-lg font-semibold mb-3">P&L acumulado</h2>
            {equity.length > 1 ? (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={equity}>
                  <defs>
                    <linearGradient id="pnl" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#34d399" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="t" hide />
                  <YAxis tick={{ fontSize: 11 }} stroke="#888" tickFormatter={(v) => `$${v.toFixed(0)}`} width={56} />
                  <Tooltip formatter={(v) => [fmtUsd(Number(v)), "P&L"]} labelFormatter={() => ""} contentStyle={{ background: "#1e1e2e", border: "none", borderRadius: 8, fontSize: 12 }} />
                  <Area type="monotone" dataKey="pnl" stroke="#34d399" strokeWidth={2} fill="url(#pnl)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-neutral-500 text-sm py-12 text-center">Acumulando datos…</p>
            )}
          </section>
        </div>

        {/* Oportunidades cross-exchange */}
        <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 mt-6">
          <h2 className="text-lg font-semibold mb-3">Oportunidades cross-exchange</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-neutral-400 border-b border-neutral-800">
                <tr>
                  <th className="text-left py-2">Comprar → Vender</th>
                  <th className="text-right">Bruto</th>
                  <th className="text-right">Vol.</th>
                  <th className="text-right">Fees</th>
                  <th className="text-right">Latencia</th>
                  <th className="text-right">Neto</th>
                  <th className="text-right">Estado</th>
                </tr>
              </thead>
              <tbody>
                {opps.slice(0, 8).map((o) => (
                  <tr key={`${o.buyEx}-${o.sellEx}`} className="border-b border-neutral-800/40">
                    <td className="py-2">{EXCHANGE_LABEL[o.buyEx]} → {EXCHANGE_LABEL[o.sellEx]}</td>
                    <td className="text-right font-mono">{o.grossBps.toFixed(1)} bps</td>
                    <td className="text-right font-mono">{o.maxQty > 0 ? fmtNum(o.maxQty, 3) : "—"}</td>
                    <td className="text-right font-mono text-neutral-500">{fmtUsd(o.feesCost)}</td>
                    <td className="text-right font-mono text-neutral-500">{fmtUsd(o.latencyCost)}</td>
                    <td className={`text-right font-mono ${o.netProfit > 0 ? "text-emerald-400" : "text-neutral-500"}`}>{fmtUsd(o.netProfit)}</td>
                    <td className="text-right">
                      {o.viable ? <span className="text-emerald-400 text-xs">✓ viable</span> : <span className="text-neutral-500 text-xs">no neto</span>}
                    </td>
                  </tr>
                ))}
                {opps.length === 0 && (
                  <tr><td colSpan={7} className="text-center text-neutral-500 py-4">Sin divergencias brutas en este instante.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Heatmap de spreads */}
        <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 mt-6">
          <h2 className="text-lg font-semibold mb-1">Matriz de spreads <span className="text-neutral-500 text-sm font-normal">· neto en bps (compra → vende)</span></h2>
          <p className="text-sm text-neutral-400 mb-3">Verde = oportunidad neta positiva. Todas las combinaciones de los {EXCHANGES.length} venues a la vez.</p>
          <SpreadMatrix opps={opps} exchanges={[...EXCHANGES]} />
        </section>

        {/* Estadístico + Analítica de sesión */}
        <div className="grid md:grid-cols-2 gap-6 mt-6">
          <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
            <h2 className="text-lg font-semibold mb-1">Arbitraje estadístico</h2>
            <p className="text-sm text-neutral-400 mb-3">Z-score del mayor spread bruto vs su media móvil. |z| alto = spread inusual (mean-reversion).</p>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div><p className="text-xs text-neutral-400">Spread actual</p><p className="font-mono text-lg">{stat.current.toFixed(1)} bps</p></div>
              <div><p className="text-xs text-neutral-400">Media móvil</p><p className="font-mono text-lg">{stat.mean.toFixed(1)} bps</p></div>
              <div><p className="text-xs text-neutral-400">Z-score</p><p className={`font-mono text-lg ${Math.abs(stat.z) > 2 ? "text-amber-400" : ""}`}>{stat.z.toFixed(2)}</p></div>
            </div>
            {Math.abs(stat.z) > 2 && <p className="text-amber-400 text-xs mt-3">⚡ Spread {stat.z > 0 ? "inusualmente amplio" : "comprimido"} — posible señal de mean-reversion.</p>}
          </section>

          <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
            <h2 className="text-lg font-semibold mb-3">Analítica de sesión</h2>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <Stat label="Tiempo activo" value={fmtDuration(Date.now() - (session.startTs || Date.now()))} />
              <Stat label="Oportunidades vistas" value={session.oppsSeen.toLocaleString()} />
              <Stat label="Viables detectadas" value={session.viableSeen.toLocaleString()} />
              <Stat label="Capture rate" value={session.viableSeen ? `${((trades.length / session.viableSeen) * 100).toFixed(0)}%` : "—"} />
              <Stat label="Volumen operado" value={`${fmtNum(session.volumeBtc, 3)} BTC`} />
              <Stat label="Mejor operación" value={fmtUsd(session.bestTrade)} />
              <Stat label="Rebalanceos" value={`${session.rebalances}`} />
            </div>
          </section>
        </div>

        {/* Arbitraje triangular */}
        <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 mt-6">
          <h2 className="text-lg font-semibold mb-1">Arbitraje triangular <span className="text-neutral-500 text-sm font-normal">· Coinbase (USD/BTC/ETH)</span></h2>
          <p className="text-sm text-neutral-400 mb-3">Ciclos intra-exchange sin mover fondos entre plataformas.</p>
          <div className="grid sm:grid-cols-2 gap-3">
            {tri?.results.map((r) => (
              <div key={r.direction} className="rounded-lg border border-neutral-800 bg-neutral-950/50 p-3">
                <div className="font-mono text-xs text-neutral-300">{r.direction}</div>
                <div className="flex items-center justify-between mt-1">
                  <span className={`text-lg font-semibold ${r.viable ? "text-emerald-400" : "text-rose-400"}`}>{r.netBps.toFixed(1)} bps</span>
                  <span className="text-xs text-neutral-500">{r.viable ? "✓ viable" : "no rentable"}</span>
                </div>
              </div>
            ))}
            {!tri && <p className="text-neutral-500 text-sm">Conectando…</p>}
          </div>
        </section>

        {/* Trades + Wallets */}
        <div className="grid lg:grid-cols-2 gap-6 mt-6">
          <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
            <h2 className="text-lg font-semibold mb-3">Operaciones ejecutadas</h2>
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {trades.length === 0 && <p className="text-neutral-500 text-sm">Aún sin operaciones netas-positivas.</p>}
              {trades.map((t) => (
                <div key={t.id + t.ts} className="flex items-center justify-between text-xs py-1 border-b border-neutral-800/40">
                  <span className="text-neutral-300">
                    {EXCHANGE_LABEL[t.buyEx]} → {EXCHANGE_LABEL[t.sellEx]}
                    {t.partial && <span className="text-amber-500 ml-1">(parcial)</span>}
                  </span>
                  <span className="font-mono text-neutral-400">{fmtNum(t.qty, 4)} BTC</span>
                  <span className="font-mono text-emerald-400">{fmtUsd(t.netProfit)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
            <h2 className="text-lg font-semibold mb-1">Balances de wallets</h2>
            <p className="text-xs text-neutral-500 mb-3">Total: {fmtUsd(totalUsd)} + {fmtNum(totalBtc, 3)} BTC</p>
            <div className="space-y-2">
              {Object.values(wallets).map((w) => (
                <div key={w.exchange} className="flex items-center justify-between text-sm py-1 border-b border-neutral-800/40">
                  <span className="w-24">{EXCHANGE_LABEL[w.exchange]}</span>
                  <span className="font-mono text-neutral-300">{fmtUsd(w.usd)}</span>
                  <span className="font-mono text-neutral-400">{fmtNum(w.btc, 4)} BTC</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <p className="text-xs text-neutral-600 mt-6">
          Simulación educativa / demo (no opera capital real). Net = bruto − fees taker − slippage (order book real)
          − adverse selection por latencia − retiro amortizado. Feeds: WebSocket (Coinbase/Kraken/Bitstamp) + REST.
        </p>
      </div>
    </main>
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

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-neutral-400">{label}</span>
        <span className={`w-1.5 h-1.5 rounded-full ${good ? "bg-emerald-400" : "bg-neutral-600"}`} />
      </div>
      <p className="font-mono text-base mt-0.5">{value}</p>
    </div>
  );
}

function Kpi({ label, value, sub, accent, big }: { label: string; value: string; sub?: string; accent?: boolean; big?: boolean }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
      <p className="text-xs text-neutral-400 uppercase tracking-wide">{label}</p>
      <p className={`font-semibold mt-1 ${big ? "text-2xl" : "text-lg"} ${accent === undefined ? "" : accent ? "text-emerald-400" : "text-rose-400"}`}>{value}</p>
      {sub && <p className="text-xs text-neutral-500 mt-0.5">{sub}</p>}
    </div>
  );
}
