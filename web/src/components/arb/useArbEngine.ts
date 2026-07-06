"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DET_WINDOW,
  EXCHANGES,
  POLL_MS,
  SPREAD_WINDOW,
  TRIANGULAR_POLL_MS,
} from "@/lib/arb/config";
import { mergeBooks, percentile } from "@/lib/arb/mergeBooks";
import { LiveFeed, type FeedStatus } from "@/lib/arb/livefeed";
import { L2Feed } from "@/lib/arb/l2book";
import { applyChaos, chaosActive, NO_CHAOS, type ChaosState } from "@/lib/arb/chaos";
import { freshDefaults, mergeParams, PRESETS, type EngineParams, type PresetId } from "@/lib/arb/params";
import type { RiskState } from "@/lib/arb/risk";
import {
  initSimState,
  initWallets,
  rearm,
  stepSession,
  emptyStats,
  type SessionStats,
  type SimState,
} from "@/lib/arb/simulator";
import { pushCapped, zScore, type ZScore } from "@/lib/arb/stats";
import { detectTriangular, type TriBooks, type TriResult } from "@/lib/arb/triangular";
import type { OrderBook, Opportunity, Trade, Transfer, Wallet } from "@/lib/arb/types";

export type { SessionStats } from "@/lib/arb/simulator";

export const FEE_TIERS = [
  { id: "retail", label: "Retail", mult: 1 },
  { id: "pro", label: "Pro", mult: 0.4 },
  { id: "vip", label: "VIP / HFT", mult: 0.1 },
  { id: "maker", label: "Maker 0%", mult: 0 },
] as const;
export type FeeTierId = (typeof FEE_TIERS)[number]["id"];

export type Metrics = { detP50: number; detP99: number; wsRate: number; freshnessMs: number };

// --- Laboratorio: configs corriendo en paralelo sobre el mismo mercado ---
export type LabConfigId = PresetId | "actual";

export type LabRunSummary = {
  id: LabConfigId;
  label: string;
  color: string;
  pnl: number;
  filled: number;
  aborted: number;
  viableSeen: number;
  volumeBtc: number;
  rebalances: number;
  breaker: "ok" | "cooldown" | "halt";
};

export type LabView = {
  active: boolean; // sigue avanzando con cada tick
  startTs: number;
  ticks: number;
  runs: LabRunSummary[];
  series: Array<Record<string, number>>; // { t, [configId]: pnl }
};

const LAB_COLORS: Record<LabConfigId, string> = {
  conservador: "#34d399",
  balanceado: "#22d3ee",
  agresivo: "#fbbf24",
  actual: "#a78bfa",
};
const LAB_SERIES_MAX = 240;

type LabRun = {
  id: LabConfigId;
  label: string;
  color: string;
  params: EngineParams;
  state: SimState;
  risk: RiskState | null;
};
type LabInternal = { active: boolean; startTs: number; ticks: number; series: Array<Record<string, number>>; runs: LabRun[] };
const emptyLab = (): LabInternal => ({ active: false, startTs: 0, ticks: 0, series: [], runs: [] });

const PARAMS_KEY = "atalaya.params.v1";
const SESSION_KEY = "atalaya.session.v3"; // v3: snapshot del SimState del simulador
const SESSION_MAX_AGE_MS = 24 * 3600_000;

type SavedSession = {
  wallets: Record<string, Wallet>;
  pnl: number;
  peakPnl: number;
  trades: Trade[];
  equity: { t: number; pnl: number }[];
  stats: SessionStats;
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

/** Reconstruye el estado del simulador desde un snapshot persistido.
 *  Lo transitorio (órdenes pendientes, racha de abortos, cooldown) arranca
 *  limpio: no tiene sentido re-verificar oportunidades de hace horas. */
function restoreSimState(saved: SavedSession, p: EngineParams): SimState {
  const state = initSimState(p);
  const wallets = initWallets(p);
  for (const ex of EXCHANGES) {
    if (saved.wallets?.[ex]) wallets[ex] = saved.wallets[ex];
  }
  state.wallets = wallets;
  state.pnl = saved.pnl ?? 0;
  state.peakPnl = saved.peakPnl ?? Math.max(0, state.pnl);
  state.trades = saved.trades ?? [];
  state.equity = saved.equity ?? [];
  state.stats = { ...emptyStats(), ...saved.stats };
  state.transfers = (saved.transfers ?? []).filter((t) => wallets[t.to] && wallets[t.from]);
  return state;
}

/** Feeds, tick del motor primario, laboratorio, métricas y persistencia. */
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
  const [risk, setRisk] = useState<RiskState>({ tripped: false, hard: false, reasons: [], maxBookAgeMs: 0 });
  const [breakerUntil, setBreakerUntil] = useState(0);
  const [tri, setTri] = useState<{ results: TriResult[]; ts: number } | null>(null);
  const [metrics, setMetrics] = useState<Metrics>({ detP50: 0, detP99: 0, wsRate: 0, freshnessMs: 0 });
  const [stat, setStat] = useState<ZScore & { current: number }>({ mean: 0, std: 0, z: 0, n: 0, current: 0 });
  const [session, setSession] = useState<SessionStats>(emptyStats);
  const [chaos, setChaosState] = useState<ChaosState>(NO_CHAOS);
  const [pendingPairs, setPendingPairs] = useState<string[]>([]);
  const [restored, setRestored] = useState(false);
  const [nowTs, setNowTs] = useState(0); // reloj del último tick (evita Date.now() en render)
  const [lab, setLab] = useState<LabView>({ active: false, startTs: 0, ticks: 0, runs: [], series: [] });

  // Estado del simulador primario + refs que el intervalo lee "frescos".
  const simRef = useRef<SimState>(initSimState(freshDefaults()));
  const labRef = useRef<LabInternal>(emptyLab());
  const detTimesRef = useRef<number[]>([]);
  const spreadHistRef = useRef<number[]>([]);
  const runningRef = useRef(running);
  const paramsRef = useRef(params);
  const chaosRef = useRef(chaos);
  const preChaosRef = useRef<{ merged: OrderBook[]; serverLatencyMs: number } | null>(null);
  const feedRef = useRef<LiveFeed | null>(null);
  const l2Ref = useRef<L2Feed | null>(null);

  // Sincronizar refs tras cada commit (los closures del intervalo los leen frescos).
  useEffect(() => {
    runningRef.current = running;
    paramsRef.current = params;
    chaosRef.current = chaos;
  }, [running, params, chaos]);

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
        // Migración: snapshots de esquemas previos quedarían huérfanos para siempre.
        window.localStorage.removeItem("atalaya.session.v1");
        window.localStorage.removeItem("atalaya.session.v2");
        const raw = window.localStorage.getItem(SESSION_KEY);
        if (raw) {
          const saved = JSON.parse(raw) as SavedSession;
          if (saved.savedAt && Date.now() - saved.savedAt < SESSION_MAX_AGE_MS) {
            simRef.current = restoreSimState(saved, p);
            sessionRestored = true;
          }
        }
      } catch {
        /* snapshot corrupto → sesión limpia */
      }
      if (!sessionRestored) {
        simRef.current = initSimState(p, Date.now());
      }
      const s = simRef.current;
      setWallets(s.wallets);
      setPnl(s.pnl);
      setTrades(s.trades);
      setEquity(s.equity);
      setTransfers(s.transfers);
      setSession({ ...s.stats });
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
        const s = simRef.current;
        const snap: SavedSession = {
          wallets: s.wallets,
          pnl: s.pnl,
          peakPnl: s.peakPnl,
          trades: s.trades,
          equity: s.equity,
          stats: s.stats,
          transfers: s.transfers,
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
  // solaparía ticks y sus actualizaciones de estado se pisarían entre sí.

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

    // Motor primario: un paso del simulador (medimos su latencia de cómputo).
    const t0 = performance.now();
    const out = stepSession(simRef.current, map, merged, p, now, runningRef.current);
    detTimesRef.current = pushCapped(detTimesRef.current, performance.now() - t0, DET_WINDOW);
    simRef.current = out.state;

    // Laboratorio: cada config sombra avanza sobre LOS MISMOS libros (incluido
    // el caos inyectado) con su propia economía independiente.
    const labI = labRef.current;
    if (labI.active && labI.runs.length) {
      for (const run of labI.runs) {
        const r = stepSession(run.state, map, merged, run.params, now, true);
        run.state = r.state;
        run.risk = r.risk;
      }
      labI.ticks += 1;
      const point: Record<string, number> = { t: now };
      for (const run of labI.runs) point[run.id] = +run.state.pnl.toFixed(2);
      labI.series = [...labI.series, point].slice(-LAB_SERIES_MAX);
      setLab(labViewOf(labI, now));
    }

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
    const maxGross = out.detectedRaw.length ? Math.max(...out.detectedRaw.map((o) => o.grossBps)) : 0;
    spreadHistRef.current = pushCapped(spreadHistRef.current, maxGross, SPREAD_WINDOW);
    setStat({ ...zScore(spreadHistRef.current), current: maxGross });

    // Espejos para render.
    const s = out.state;
    setOpps(out.detected);
    setRisk(out.risk);
    setBreakerUntil(s.breakerUntil);
    setWallets(s.wallets);
    setPnl(s.pnl);
    setTrades(s.trades);
    setTransfers(s.transfers);
    setPendingPairs(s.pending.map((po) => `${po.opp.buyEx}>${po.opp.sellEx}`));
    setSession({ ...s.stats });
    setEquity(s.equity);
    setNowTs(now);
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
    simRef.current = rearm(simRef.current);
    setBreakerUntil(0);
    setRisk((prev) => ({ ...prev, tripped: false, reasons: [] })); // optimista; el próximo tick re-evalúa
  }, []);

  // --- Laboratorio de experimentos ---
  const startLab = useCallback((ids: LabConfigId[]) => {
    // Defensa en profundidad (la UI ya lo garantiza): sin duplicados, ids
    // conocidos, y mínimo 2 configs para que comparar tenga sentido.
    const valid = [...new Set(ids)].filter((id) => id === "actual" || PRESETS.some((x) => x.id === id));
    if (valid.length < 2) return;
    const now = Date.now();
    const current = paramsRef.current;
    const runs: LabRun[] = valid.map((id) => {
      const preset = PRESETS.find((x) => x.id === id);
      // Presets se aplican sobre TU config actual: mismo tier/fees/venues en
      // todas las corridas — solo difieren los knobs de estrategia (comparación justa).
      const runParams = preset ? preset.apply(structuredClone(current)) : structuredClone(current);
      return {
        id,
        label: preset?.label ?? "Tu config actual",
        color: LAB_COLORS[id],
        params: runParams,
        state: initSimState(runParams, now),
        risk: null,
      };
    });
    labRef.current = { active: true, startTs: now, ticks: 0, series: [], runs };
    setLab(labViewOf(labRef.current, now));
  }, []);

  const stopLab = useCallback(() => {
    labRef.current.active = false;
    setLab(labViewOf(labRef.current, Date.now()));
  }, []);

  const clearLab = useCallback(() => {
    labRef.current = emptyLab();
    setLab({ active: false, startTs: 0, ticks: 0, runs: [], series: [] });
  }, []);

  const reset = useCallback(() => {
    simRef.current = initSimState(paramsRef.current, Date.now());
    const s = simRef.current;
    setWallets(s.wallets);
    setTrades([]);
    setPnl(0);
    setEquity([]);
    setTransfers([]);
    setPendingPairs([]);
    setBreakerUntil(0);
    setTickCount(0);
    setSession({ ...s.stats });
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
    breakerUntil,
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
    lab,
    // controles
    patchParams,
    applyPreset,
    resetParams,
    setChaos,
    clearChaos,
    rearmBreaker,
    startLab,
    stopLab,
    clearLab,
    toggleRunning: () => setRunning((v) => !v),
    reset,
  };
}

function labViewOf(lab: LabInternal, now: number): LabView {
  return {
    active: lab.active,
    startTs: lab.startTs,
    ticks: lab.ticks,
    series: lab.series,
    runs: lab.runs.map((run) => ({
      id: run.id,
      label: run.label,
      color: run.color,
      pnl: run.state.pnl,
      filled: run.state.stats.filledCount,
      aborted: run.state.stats.aborted,
      viableSeen: run.state.stats.viableSeen,
      volumeBtc: run.state.stats.volumeBtc,
      rebalances: run.state.stats.rebalances,
      breaker: run.risk?.tripped ? (run.state.breakerUntil >= now ? "cooldown" : "halt") : "ok",
    })),
  };
}
