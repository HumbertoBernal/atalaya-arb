"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DET_WINDOW,
  EQUITY_WINDOW,
  MAKER_FEE,
  POLL_MS,
  SPREAD_WINDOW,
  TAKER_FEE,
  TRADES_MAX,
  TRIANGULAR_POLL_MS,
  INITIAL_BTC,
  INITIAL_USD,
} from "@/lib/arb/config";
import { detectOpportunities, simulateExecution } from "@/lib/arb/engine";
import { mergeBooks, percentile, referencePrice } from "@/lib/arb/mergeBooks";
import { LiveFeed, type FeedStatus } from "@/lib/arb/livefeed";
import { L2Feed } from "@/lib/arb/l2book";
import { needsRebalance, rebalance } from "@/lib/arb/rebalance";
import { evaluateRisk, sanitizeOpportunities, type RiskState } from "@/lib/arb/risk";
import { pushCapped, zScore, type ZScore } from "@/lib/arb/stats";
import { detectTriangular, type TriBooks, type TriResult } from "@/lib/arb/triangular";
import type { OrderBook, Opportunity, Trade, Wallet } from "@/lib/arb/types";

export const FEE_TIERS = [
  { id: "retail", label: "Retail", mult: 1 },
  { id: "pro", label: "Pro", mult: 0.4 },
  { id: "vip", label: "VIP / HFT", mult: 0.1 },
  { id: "maker", label: "Maker 0%", mult: 0 },
] as const;
export type FeeTierId = (typeof FEE_TIERS)[number]["id"];

export type Metrics = { detP50: number; detP99: number; wsRate: number; freshnessMs: number };
export type SessionStats = {
  oppsSeen: number;
  viableSeen: number;
  volumeBtc: number;
  bestTrade: number;
  rebalances: number;
  startTs: number;
};
const emptySession = (): SessionStats => ({
  oppsSeen: 0,
  viableSeen: 0,
  volumeBtc: 0,
  bestTrade: 0,
  rebalances: 0,
  startTs: 0,
});

function initWallets(): Record<string, Wallet> {
  const w: Record<string, Wallet> = {};
  for (const ex of Object.keys(TAKER_FEE)) w[ex] = { exchange: ex, usd: INITIAL_USD, btc: INITIAL_BTC };
  return w;
}
const feeMultOf = (id: FeeTierId) => FEE_TIERS.find((t) => t.id === id)?.mult ?? 1;

/** Toda la lógica del motor de arbitraje: feeds, tick, ejecución, métricas. */
export function useArbEngine() {
  const [books, setBooks] = useState<OrderBook[]>([]);
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [wallets, setWallets] = useState<Record<string, Wallet>>(initWallets);
  const [pnl, setPnl] = useState(0);
  const [equity, setEquity] = useState<{ t: number; pnl: number }[]>([]);
  const [running, setRunning] = useState(true);
  const [feeTier, setFeeTier] = useState<FeeTierId>("vip");
  const [makerMode, setMakerMode] = useState(false);
  const [serverLatency, setServerLatency] = useState(0);
  const [tickCount, setTickCount] = useState(0);
  const [feedStatus, setFeedStatus] = useState<Record<string, FeedStatus>>({});
  const [risk, setRisk] = useState<RiskState>({ tripped: false, reasons: [], maxBookAgeMs: 0 });
  const [tri, setTri] = useState<{ results: TriResult[]; ts: number } | null>(null);
  const [metrics, setMetrics] = useState<Metrics>({ detP50: 0, detP99: 0, wsRate: 0, freshnessMs: 0 });
  const [stat, setStat] = useState<ZScore & { current: number }>({ mean: 0, std: 0, z: 0, n: 0, current: 0 });
  const [session, setSession] = useState<SessionStats>(emptySession);

  // Refs que el intervalo necesita leer "frescos" (evitan stale closures).
  const detTimesRef = useRef<number[]>([]);
  const spreadHistRef = useRef<number[]>([]);
  const sessionRef = useRef<SessionStats>(emptySession());
  const walletsRef = useRef(wallets);
  const pnlRef = useRef(pnl);
  const peakPnlRef = useRef(0);
  const runningRef = useRef(running);
  const feeRef = useRef(feeTier);
  const makerRef = useRef(makerMode);
  const feedRef = useRef<LiveFeed | null>(null);
  const l2Ref = useRef<L2Feed | null>(null);
  walletsRef.current = wallets;
  pnlRef.current = pnl;
  runningRef.current = running;
  feeRef.current = feeTier;
  makerRef.current = makerMode;

  // Arranca los feeds WebSocket una vez: top-of-book (LiveFeed) + L2 completo.
  useEffect(() => {
    const feed = new LiveFeed();
    feed.start();
    feedRef.current = feed;
    const l2 = new L2Feed();
    l2.start();
    l2Ref.current = l2;
    sessionRef.current.startTs = Date.now();
    setSession({ ...sessionRef.current });
    return () => {
      feed.close();
      l2.close();
    };
  }, []);

  const tick = useCallback(async () => {
    const mult = feeMultOf(feeRef.current);
    const maker = makerRef.current;

    let payload: { books: OrderBook[]; serverLatencyMs: number };
    try {
      const res = await fetch("/api/orderbooks", { cache: "no-store" });
      payload = await res.json();
    } catch {
      return;
    }

    // Combinar REST + L2 + tops de WS (L2 preferido cuando es válido).
    const { map, merged } = mergeBooks(
      payload.books,
      l2Ref.current?.getBooks() ?? {},
      feedRef.current?.getTops() ?? {},
      Date.now(),
    );
    setBooks(merged);
    setServerLatency(payload.serverLatencyMs);
    setFeedStatus({ ...(feedRef.current?.getStatus() ?? {}), ...(l2Ref.current?.getStatus() ?? {}) });
    setTickCount((c) => c + 1);

    // Detección (medimos su latencia de cómputo).
    const t0 = performance.now();
    const detectedRaw = detectOpportunities(map, mult, maker);
    detTimesRef.current = pushCapped(detTimesRef.current, performance.now() - t0, DET_WINDOW);
    const detected = sanitizeOpportunities(detectedRaw);
    setOpps(detected);

    // Métricas de latencia/throughput.
    const wsRate =
      Object.values(feedRef.current?.getRates() ?? {}).reduce((a, b) => a + b, 0) +
      Object.values(l2Ref.current?.getRates() ?? {}).reduce((a, b) => a + b, 0);
    const ages = merged.filter((b) => b.ok).map((b) => Date.now() - b.ts);
    setMetrics({
      detP50: percentile(detTimesRef.current, 50),
      detP99: percentile(detTimesRef.current, 99),
      wsRate,
      freshnessMs: ages.length ? Math.min(...ages) : 0,
    });

    // Arbitraje estadístico (z-score del mayor spread).
    const maxGross = detectedRaw.length ? Math.max(...detectedRaw.map((o) => o.grossBps)) : 0;
    spreadHistRef.current = pushCapped(spreadHistRef.current, maxGross, SPREAD_WINDOW);
    setStat({ ...zScore(spreadHistRef.current), current: maxGross });

    const s = sessionRef.current;
    s.oppsSeen += detectedRaw.length;
    s.viableSeen += detected.filter((o) => o.viable).length;

    // Circuit breaker.
    const r = evaluateRisk(merged, detectedRaw, pnlRef.current, peakPnlRef.current, Date.now());
    setRisk(r);

    // Ejecución (si corre y el breaker no está disparado).
    if (runningRef.current && !r.tripped) {
      let w = walletsRef.current;
      const newTrades: Trade[] = [];
      let gained = 0;
      for (const opp of detected.filter((o) => o.viable)) {
        const { trade, wallets: nextW } = simulateExecution(opp, map, w, mult, maker);
        if (trade) {
          w = nextW;
          newTrades.push(trade);
          gained += trade.netProfit;
        }
      }

      // Rebalanceo de inventario si algún venue se agotó.
      let rebalanceCost = 0;
      const refP = referencePrice(merged);
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
          setTrades((prev) => [...newTrades.reverse(), ...prev].slice(0, TRADES_MAX));
          for (const tr of newTrades) {
            s.volumeBtc += tr.qty;
            s.bestTrade = Math.max(s.bestTrade, tr.netProfit);
          }
        }
      }
    }
    setSession({ ...s });
    setEquity((prev) => [...prev, { t: Date.now(), pnl: pnlRef.current }].slice(-EQUITY_WINDOW));
  }, []);

  // Bucle principal.
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
        const base = makerRef.current ? (MAKER_FEE.coinbase ?? 0.004) : (TAKER_FEE.coinbase ?? 0.006);
        setTri({ results: detectTriangular(d.books as TriBooks, base * feeMultOf(feeRef.current)), ts: d.ts });
      } catch {
        /* feed opcional; se reintenta en el próximo intervalo */
      }
    };
    run();
    const id = setInterval(run, TRIANGULAR_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const reset = useCallback(() => {
    setWallets(initWallets());
    setTrades([]);
    setPnl(0);
    peakPnlRef.current = 0;
    setEquity([]);
    setTickCount(0);
    sessionRef.current = { ...emptySession(), startTs: Date.now() };
    setSession({ ...sessionRef.current });
    spreadHistRef.current = [];
  }, []);

  return {
    // estado para render
    books,
    opps,
    trades,
    wallets,
    pnl,
    equity,
    metrics,
    stat,
    session,
    risk,
    tri,
    feedStatus,
    serverLatency,
    tickCount,
    running,
    feeTier,
    makerMode,
    // controles
    setFeeTier,
    setMakerMode,
    toggleRunning: () => setRunning((v) => !v),
    reset,
  };
}
