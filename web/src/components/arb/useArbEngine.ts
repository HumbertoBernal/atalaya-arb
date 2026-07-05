"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DET_WINDOW,
  EQUITY_WINDOW,
  EXCHANGES,
  POLL_MS,
  SPREAD_WINDOW,
  TRADES_MAX,
  TRIANGULAR_POLL_MS,
} from "@/lib/arb/config";
import {
  abortedTrade,
  detectOpportunities,
  recheckOpportunity,
  simulateExecution,
} from "@/lib/arb/engine";
import { mergeBooks, percentile, referencePrice } from "@/lib/arb/mergeBooks";
import { LiveFeed, type FeedStatus } from "@/lib/arb/livefeed";
import { L2Feed } from "@/lib/arb/l2book";
import { applyChaos, chaosActive, NO_CHAOS, type ChaosState } from "@/lib/arb/chaos";
import {
  creditTransfer,
  debitTransfers,
  needsRebalance,
  planRebalance,
  projectWallets,
} from "@/lib/arb/rebalance";
import { freshDefaults, isActive, mergeParams, PRESETS, type EngineParams, type PresetId } from "@/lib/arb/params";
import { evaluateRisk, sanitizeOpportunities, type RiskState } from "@/lib/arb/risk";
import { pushCapped, zScore, type ZScore } from "@/lib/arb/stats";
import { detectTriangular, type TriBooks, type TriResult } from "@/lib/arb/triangular";
import type { OrderBook, Opportunity, Trade, Transfer, Wallet } from "@/lib/arb/types";

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
  filledCount: number; // fills acumulados de la sesión (el ledger se capa a TRADES_MAX)
  partialCount: number;
  volumeBtc: number;
  bestTrade: number;
  rebalances: number;
  aborted: number;
  startTs: number;
};
const emptySession = (): SessionStats => ({
  oppsSeen: 0,
  viableSeen: 0,
  filledCount: 0,
  partialCount: 0,
  volumeBtc: 0,
  bestTrade: 0,
  rebalances: 0,
  aborted: 0,
  startTs: 0,
});

// Orden en dos fases: detectada en el tick N, re-verificada y ejecutada (o
// abortada) contra el libro fresco del tick N+1 — la ventana de ejecución real.
type PendingOrder = { opp: Opportunity; createdTs: number };

const PARAMS_KEY = "atalaya.params.v1";
const SESSION_KEY = "atalaya.session.v2"; // v2: SessionStats con filledCount/partialCount
const SESSION_MAX_AGE_MS = 24 * 3600_000;

type SavedSession = {
  wallets: Record<string, Wallet>;
  pnl: number;
  peakPnl: number;
  trades: Trade[];
  equity: { t: number; pnl: number }[];
  session: SessionStats;
  transfers: Transfer[];
  savedAt: number;
};

function loadParams(): EngineParams {
  if (typeof window === "undefined") return freshDefaults();
  try {
    const raw = window.localStorage.getItem(PARAMS_KEY);
    return raw ? mergeParams(JSON.parse(raw)) : freshDefaults();
  } catch {
    return freshDefaults();
  }
}

function persistParams(p: EngineParams) {
  try {
    window.localStorage.setItem(PARAMS_KEY, JSON.stringify(p));
  } catch {
    /* storage lleno/bloqueado: seguimos en memoria */
  }
}

function initWallets(p: EngineParams): Record<string, Wallet> {
  const w: Record<string, Wallet> = {};
  for (const ex of EXCHANGES) w[ex] = { exchange: ex, usd: p.initialUsd, btc: p.initialBtc };
  return w;
}

/** Toda la lógica del motor de arbitraje: feeds, tick, ejecución, métricas. */
export function useArbEngine() {
  const [params, setParamsState] = useState<EngineParams>(freshDefaults);
  const [books, setBooks] = useState<OrderBook[]>([]);
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [wallets, setWallets] = useState<Record<string, Wallet>>(() => initWallets(freshDefaults()));
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [pnl, setPnl] = useState(0);
  const [equity, setEquity] = useState<{ t: number; pnl: number }[]>([]);
  const [running, setRunning] = useState(true);
  const [serverLatency, setServerLatency] = useState(0);
  const [tickCount, setTickCount] = useState(0);
  const [feedStatus, setFeedStatus] = useState<Record<string, FeedStatus>>({});
  const [risk, setRisk] = useState<RiskState>({ tripped: false, reasons: [], maxBookAgeMs: 0 });
  const [tri, setTri] = useState<{ results: TriResult[]; ts: number } | null>(null);
  const [metrics, setMetrics] = useState<Metrics>({ detP50: 0, detP99: 0, wsRate: 0, freshnessMs: 0 });
  const [stat, setStat] = useState<ZScore & { current: number }>({ mean: 0, std: 0, z: 0, n: 0, current: 0 });
  const [session, setSession] = useState<SessionStats>(emptySession);
  const [chaos, setChaosState] = useState<ChaosState>(NO_CHAOS);
  const [pendingPairs, setPendingPairs] = useState<string[]>([]);
  const [restored, setRestored] = useState(false);
  const [nowTs, setNowTs] = useState(0); // reloj del último tick (evita Date.now() en render)

  // Refs que el intervalo necesita leer "frescos" (evitan stale closures).
  const detTimesRef = useRef<number[]>([]);
  const spreadHistRef = useRef<number[]>([]);
  const sessionRef = useRef<SessionStats>(emptySession());
  const walletsRef = useRef(wallets);
  const tradesRef = useRef<Trade[]>([]);
  const equityRef = useRef<{ t: number; pnl: number }[]>([]);
  const transfersRef = useRef<Transfer[]>([]);
  const pendingRef = useRef<PendingOrder[]>([]);
  const abortsRef = useRef(0); // abortos consecutivos → circuit breaker
  const pnlRef = useRef(pnl);
  const peakPnlRef = useRef(0);
  const runningRef = useRef(running);
  const paramsRef = useRef(params);
  const chaosRef = useRef(chaos);
  const preChaosRef = useRef<{ merged: OrderBook[]; serverLatencyMs: number } | null>(null);
  const feedRef = useRef<LiveFeed | null>(null);
  const l2Ref = useRef<L2Feed | null>(null);

  // Sincronizar refs tras cada commit (los closures del intervalo los leen frescos).
  useEffect(() => {
    walletsRef.current = wallets;
    pnlRef.current = pnl;
    runningRef.current = running;
    paramsRef.current = params;
    chaosRef.current = chaos;
  }, [wallets, pnl, running, params, chaos]);

  // Arranque (solo cliente): restaurar params + sesión persistida y abrir feeds.
  useEffect(() => {
    // La restauración corre en microtask: el estado persistido solo existe en
    // el cliente y así el primer render coincide con el HTML del servidor.
    queueMicrotask(() => {
      const p = loadParams();
      setParamsState(p);
      paramsRef.current = p;

      let sessionRestored = false;
      try {
        const raw = window.localStorage.getItem(SESSION_KEY);
        if (raw) {
          const saved = JSON.parse(raw) as SavedSession;
          if (saved.savedAt && Date.now() - saved.savedAt < SESSION_MAX_AGE_MS) {
            // Merge sobre initWallets: si el snapshot viene de un esquema con
            // otros venues, los faltantes arrancan con capital y los extra se caen.
            const restoredW = initWallets(p);
            for (const ex of EXCHANGES) {
              if (saved.wallets?.[ex]) restoredW[ex] = saved.wallets[ex];
            }
            setWallets(restoredW);
            walletsRef.current = restoredW;
            setPnl(saved.pnl);
            pnlRef.current = saved.pnl;
            peakPnlRef.current = saved.peakPnl ?? Math.max(0, saved.pnl);
            setTrades(saved.trades ?? []);
            tradesRef.current = saved.trades ?? [];
            setEquity(saved.equity ?? []);
            equityRef.current = saved.equity ?? [];
            sessionRef.current = { ...emptySession(), ...saved.session };
            transfersRef.current = saved.transfers ?? [];
            setTransfers(transfersRef.current);
            sessionRestored = true;
          }
        }
      } catch {
        /* snapshot corrupto → sesión limpia */
      }
      if (!sessionRestored) {
        const w = initWallets(p);
        setWallets(w);
        walletsRef.current = w;
        sessionRef.current.startTs = Date.now();
      }
      setSession({ ...sessionRef.current });
      setRestored(sessionRestored);
    });

    const feed = new LiveFeed();
    feed.start();
    feedRef.current = feed;
    const l2 = new L2Feed();
    l2.start();
    l2Ref.current = l2;

    // Autosave del snapshot de sesión (para sobrevivir recargas).
    const saveId = setInterval(() => {
      try {
        const snap: SavedSession = {
          wallets: walletsRef.current,
          pnl: pnlRef.current,
          peakPnl: peakPnlRef.current,
          trades: tradesRef.current,
          equity: equityRef.current,
          session: sessionRef.current,
          transfers: transfersRef.current,
          savedAt: Date.now(),
        };
        window.localStorage.setItem(SESSION_KEY, JSON.stringify(snap));
      } catch {
        /* storage lleno/bloqueado */
      }
    }, 5000);

    return () => {
      clearInterval(saveId);
      feed.close();
      l2.close();
    };
  }, []);

  const busyRef = useRef(false); // guard de re-entrada: un fetch lento (>POLL_MS)
  // solaparía ticks y sus setWallets se pisarían entre sí (P&L ≠ wallets).

  const tickBody = useCallback(async () => {
    let payload: { books: OrderBook[]; serverLatencyMs: number };
    try {
      const res = await fetch("/api/orderbooks", { cache: "no-store" });
      payload = await res.json();
    } catch {
      return;
    }

    // Leer params/caos DESPUÉS del await: así el primer tick ya ve los valores
    // restaurados de localStorage (el microtask corre durante el fetch).
    const p = paramsRef.current;
    const c = chaosRef.current;
    const now = Date.now();

    // Combinar REST + L2 + tops de WS (L2 preferido cuando es válido).
    const fresh = mergeBooks(
      payload.books,
      l2Ref.current?.getBooks() ?? {},
      feedRef.current?.getTops() ?? {},
      now,
    );

    // Modo caos: "congelar feeds" reusa el último snapshot pre-caos (su edad
    // crece tick a tick hasta disparar el breaker de staleness). El resto de
    // los escenarios se inyectan sobre el snapshot vigente.
    let baseline = { merged: fresh.merged, serverLatencyMs: payload.serverLatencyMs };
    if (c.freezeFeeds && preChaosRef.current) {
      baseline = preChaosRef.current;
    } else {
      preChaosRef.current = baseline;
    }
    const { merged, map } = applyChaos(baseline.merged, c, now);

    setBooks(merged);
    setServerLatency(baseline.serverLatencyMs);
    setFeedStatus({ ...(feedRef.current?.getStatus() ?? {}), ...(l2Ref.current?.getStatus() ?? {}) });
    setTickCount((cnt) => cnt + 1);

    // Detección (medimos su latencia de cómputo).
    const t0 = performance.now();
    const detectedRaw = detectOpportunities(map, p);
    detTimesRef.current = pushCapped(detTimesRef.current, performance.now() - t0, DET_WINDOW);
    const detected = sanitizeOpportunities(detectedRaw, p.risk.maxGrossBps);
    setOpps(detected);

    // Métricas de latencia/throughput.
    const wsRate =
      Object.values(feedRef.current?.getRates() ?? {}).reduce((a, b) => a + b, 0) +
      Object.values(l2Ref.current?.getRates() ?? {}).reduce((a, b) => a + b, 0);
    const ages = merged.filter((b) => b.ok).map((b) => now - b.ts);
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

    // Circuit breaker (incluye abortos de ejecución consecutivos).
    const r = evaluateRisk(merged, detectedRaw, pnlRef.current, peakPnlRef.current, now, p.risk, abortsRef.current);
    setRisk(r);

    let w = walletsRef.current;
    let walletsTouched = false;
    const newTrades: Trade[] = [];
    let gained = 0;

    // Llegadas de transferencias de rebalanceo (confirmación on-chain simulada).
    const arrivals = transfersRef.current.filter((t) => now >= t.arriveTs);
    if (arrivals.length) {
      for (const t of arrivals) w = creditTransfer(w, t);
      transfersRef.current = transfersRef.current.filter((t) => now < t.arriveTs);
      walletsTouched = true;
    }

    if (runningRef.current && !r.tripped) {
      // FASE 2: órdenes creadas el tick pasado se re-verifican contra el libro
      // fresco. Si el neto se derrumbó o el spread se cerró → aborto (visible).
      const pend = pendingRef.current;
      pendingRef.current = [];
      for (const po of pend) {
        // Venue desactivado con la orden en vuelo → se cancela sin ejecutar.
        if (!isActive(p, po.opp.buyEx) || !isActive(p, po.opp.sellEx)) continue;
        const rc = recheckOpportunity(po.opp, map, p);
        if (rc.ok && rc.fresh) {
          const { trade, wallets: nextW } = simulateExecution(rc.fresh, map, w, p);
          if (trade) {
            trade.driftBps = rc.driftBps;
            w = nextW;
            walletsTouched = true;
            newTrades.push(trade);
            gained += trade.netProfit;
            abortsRef.current = 0;
            continue;
          }
          newTrades.push(abortedTrade(po.opp, "liquidez o saldo insuficiente al ejecutar", rc.driftBps));
        } else {
          newTrades.push(abortedTrade(po.opp, rc.reason ?? "condiciones cambiaron", rc.driftBps));
        }
        // Cuenta por ORDEN abortada (un tick adverso con varias pendientes
        // puede disparar el breaker de golpe — comportamiento deseado).
        abortsRef.current += 1;
        s.aborted += 1;
      }

      // FASE 1: lo viable detectado ahora entra como orden pendiente y se
      // ejecutará (o abortará) el próximo tick — la ventana de ejecución.
      // (detectOpportunities produce cada par a lo sumo una vez.)
      for (const opp of detected.filter((o) => o.viable)) {
        pendingRef.current.push({ opp, createdTs: now });
      }

      // Rebalanceo dirigido si algún venue ACTIVO se agotó y no viene nada en
      // camino: déficits sobre saldos proyectados (real + en tránsito) para no
      // duplicar envíos; venues desactivados donan pero no reciben.
      const projected = projectWallets(w, transfersRef.current);
      const activeProjected = Object.fromEntries(
        Object.entries(projected).filter(([ex]) => isActive(p, ex)),
      );
      const refP = referencePrice(merged);
      if (refP && needsRebalance(activeProjected, p.rebalance)) {
        const plan = planRebalance(w, refP, p.rebalance, now, {
          projected,
          canReceive: (ex) => isActive(p, ex),
        });
        if (plan.transfers.length) {
          w = debitTransfers(w, plan.transfers);
          transfersRef.current = [...transfersRef.current, ...plan.transfers];
          walletsTouched = true;
          const newPnl = pnlRef.current - plan.costUsd;
          setPnl(newPnl);
          pnlRef.current = newPnl;
          s.rebalances += 1;
        }
      }
    } else if (pendingRef.current.length) {
      // Breaker activo o pausa: las órdenes pendientes se cancelan sin ejecutar.
      pendingRef.current = [];
    }

    if (newTrades.length) {
      const newPnl = pnlRef.current + gained;
      setPnl(newPnl);
      pnlRef.current = newPnl;
      peakPnlRef.current = Math.max(peakPnlRef.current, newPnl);
      const ordered = [...newTrades].reverse(); // fuera del updater (debe ser puro)
      setTrades((prev) => {
        const next = [...ordered, ...prev].slice(0, TRADES_MAX);
        tradesRef.current = next;
        return next;
      });
      for (const tr of newTrades) {
        if (tr.status !== "filled") continue;
        s.filledCount += 1;
        if (tr.partial) s.partialCount += 1;
        s.volumeBtc += tr.qty;
        s.bestTrade = Math.max(s.bestTrade, tr.netProfit);
      }
    }
    if (walletsTouched) {
      setWallets(w);
      walletsRef.current = w; // sync inmediato: no esperar al effect post-commit
    }

    setTransfers([...transfersRef.current]);
    setPendingPairs(pendingRef.current.map((po) => `${po.opp.buyEx}>${po.opp.sellEx}`));
    setNowTs(now);
    setSession({ ...s });
    setEquity((prev) => {
      const next = [...prev, { t: now, pnl: pnlRef.current }].slice(-EQUITY_WINDOW);
      equityRef.current = next;
      return next;
    });
  }, []);

  const tick = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await tickBody();
    } finally {
      busyRef.current = false;
    }
  }, [tickBody]);

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
        const p = paramsRef.current;
        const base = p.maker ? (p.makerFee.coinbase ?? 0.004) : (p.takerFee.coinbase ?? 0.006);
        setTri({ results: detectTriangular(d.books as TriBooks, base * p.feeMult), ts: d.ts });
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

  // --- Controles de parámetros (persisten en localStorage) ---
  // paramsRef se actualiza sincrónico: llamadas consecutivas componen bien y
  // el side effect (persistir) queda fuera del updater de React (debe ser puro).
  const patchParams = useCallback((patch: Partial<EngineParams>) => {
    const next = { ...paramsRef.current, ...patch };
    paramsRef.current = next;
    persistParams(next);
    setParamsState(next);
  }, []);

  const applyPreset = useCallback((id: PresetId) => {
    const preset = PRESETS.find((x) => x.id === id);
    if (!preset) return;
    const next = preset.apply(paramsRef.current);
    paramsRef.current = next;
    persistParams(next);
    setParamsState(next);
  }, []);

  const resetParams = useCallback(() => {
    const next = freshDefaults();
    paramsRef.current = next;
    persistParams(next);
    setParamsState(next);
  }, []);

  // --- Controles de caos (escenarios adversos, solo capa de simulación) ---
  const setChaos = useCallback((updater: (c: ChaosState) => ChaosState) => {
    setChaosState((prev) => updater(prev));
  }, []);
  const clearChaos = useCallback(() => setChaosState(NO_CHAOS), []);

  // Re-armar el breaker manualmente (como en una mesa real: intervención humana).
  const rearmBreaker = useCallback(() => {
    abortsRef.current = 0;
    peakPnlRef.current = pnlRef.current;
  }, []);

  const reset = useCallback(() => {
    const p = paramsRef.current;
    setWallets(initWallets(p));
    setTrades([]);
    tradesRef.current = [];
    setPnl(0);
    pnlRef.current = 0;
    peakPnlRef.current = 0;
    setEquity([]);
    equityRef.current = [];
    setTickCount(0);
    transfersRef.current = [];
    setTransfers([]);
    pendingRef.current = [];
    setPendingPairs([]);
    abortsRef.current = 0;
    sessionRef.current = { ...emptySession(), startTs: Date.now() };
    setSession({ ...sessionRef.current });
    spreadHistRef.current = [];
    setRestored(false);
    try {
      window.localStorage.removeItem(SESSION_KEY);
    } catch {
      /* noop */
    }
  }, []);

  return {
    // estado para render
    books,
    opps,
    trades,
    wallets,
    transfers,
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
    params,
    chaos,
    chaosOn: chaosActive(chaos, nowTs),
    pendingPairs,
    restored,
    nowTs,
    // controles
    patchParams,
    applyPreset,
    resetParams,
    setChaos,
    clearChaos,
    rearmBreaker,
    toggleRunning: () => setRunning((v) => !v),
    reset,
  };
}
