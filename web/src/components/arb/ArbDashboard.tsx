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
import { EXCHANGE_LABEL, INITIAL_BTC, INITIAL_USD, TAKER_FEE } from "@/lib/arb/config";
import { detectOpportunities, simulateExecution } from "@/lib/arb/engine";
import { LiveFeed, type FeedStatus } from "@/lib/arb/livefeed";
import { evaluateRisk, sanitizeOpportunities, type RiskState } from "@/lib/arb/risk";
import { detectTriangular, type TriBooks, type TriResult } from "@/lib/arb/triangular";
import type { OrderBook, OrderBooks, Opportunity, Trade, Wallet } from "@/lib/arb/types";

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

    const detectedRaw = detectOpportunities(map, mult);
    const detected = sanitizeOpportunities(detectedRaw);
    setOpps(detected);

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
      if (newTrades.length) {
        setWallets(w);
        setTrades((prev) => [...newTrades.reverse(), ...prev].slice(0, 60));
        const newPnl = pnlRef.current + gained;
        setPnl(newPnl);
        peakPnlRef.current = Math.max(peakPnlRef.current, newPnl);
      }
    }
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

function Kpi({ label, value, sub, accent, big }: { label: string; value: string; sub?: string; accent?: boolean; big?: boolean }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
      <p className="text-xs text-neutral-400 uppercase tracking-wide">{label}</p>
      <p className={`font-semibold mt-1 ${big ? "text-2xl" : "text-lg"} ${accent === undefined ? "" : accent ? "text-emerald-400" : "text-rose-400"}`}>{value}</p>
      {sub && <p className="text-xs text-neutral-500 mt-0.5">{sub}</p>}
    </div>
  );
}
