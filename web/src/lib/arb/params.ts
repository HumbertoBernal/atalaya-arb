// Parámetros del motor ajustables en RUNTIME (criterio del comité: profundidad
// y parametrización). Las constantes de config.ts son los DEFAULTS; este módulo
// define el objeto vivo que la UI edita y que se inyecta en cada función pura
// del motor. Persistido en localStorage (ver useArbEngine).
import {
  BTC_VOL_PER_SEC,
  EXCHANGES,
  INITIAL_BTC,
  INITIAL_USD,
  MAKER_FEE,
  MAKER_FILL_PROB,
  MAX_TRADE_BTC,
  MAX_WALLET_FRAC,
  NETWORK_LATENCY_MS,
  REBALANCE,
  REBALANCE_EVERY,
  RISK,
  TAKER_FEE,
  WITHDRAWAL_FEE_BTC,
} from "./config";

export type RiskParams = {
  maxBookAgeMs: number; // datos más viejos que esto = stale → halt
  maxGrossBps: number; // spread bruto mayor = probable dato corrupto → ignorar
  maxConsecutiveLosses: number; // abortos de ejecución seguidos que disparan halt
  maxDrawdownUsd: number; // caída desde el pico de P&L que dispara halt
  cooldownSec: number; // tras un halt, re-armado automático (0 = solo manual)
};

export type RebalanceParams = {
  minUsd: number; // USD mínimo por venue antes de rebalancear
  minBtc: number; // BTC mínimo por venue antes de rebalancear
  btcNetworkFee: number; // fee de red por transferencia BTC entre venues
  transferDelaySec: number; // confirmación on-chain simulada (0 = instantáneo)
  minIntervalSec: number; // cadencia mínima entre rebalanceos (control de fees)
};

export type EngineParams = {
  // --- Estrategia ---
  minNetBps: number; // umbral mínimo de margen neto (bps) para ejecutar
  maxTradeBtc: number; // tope de BTC por operación
  maxWalletFrac: number; // fracción máx. de la wallet del venue por orden (sizing por inventario)
  feeMult: number; // multiplicador de tier (1 retail … 0 maker-cero)
  maker: boolean; // órdenes límite (fee menor, fill incierto) vs taker
  makerFillProb: number; // probabilidad de fill de una orden límite
  recheckTolBps: number; // deriva de neto tolerada al re-verificar antes de ejecutar
  // --- Universo ---
  activeExchanges: Record<string, boolean>; // venues habilitados para operar
  // --- Fees por exchange (editables; fracción, no bps) ---
  takerFee: Record<string, number>;
  makerFee: Record<string, number>;
  // --- Fricciones ---
  latencyMs: Record<string, number>; // latencia de red estimada por venue
  btcVolPerSec: number; // volatilidad por segundo para adverse selection
  withdrawalFeeBtc: Record<string, number>; // retiro on-chain por venue
  rebalanceEvery: number; // operaciones entre las que se amortiza un retiro
  // --- Riesgo / circuit breaker ---
  risk: RiskParams;
  // --- Rebalanceo de inventario ---
  rebalance: RebalanceParams;
  // --- Capital inicial (aplica al Reset) ---
  initialUsd: number;
  initialBtc: number;
};

export const DEFAULT_PARAMS: EngineParams = {
  minNetBps: 0,
  maxTradeBtc: MAX_TRADE_BTC,
  maxWalletFrac: MAX_WALLET_FRAC,
  feeMult: 0.1, // tier VIP por defecto (igual que el default previo de la UI)
  maker: false,
  makerFillProb: MAKER_FILL_PROB,
  recheckTolBps: 5,
  activeExchanges: Object.fromEntries(EXCHANGES.map((e) => [e, true])),
  takerFee: { ...TAKER_FEE },
  makerFee: { ...MAKER_FEE },
  latencyMs: { ...NETWORK_LATENCY_MS },
  btcVolPerSec: BTC_VOL_PER_SEC,
  withdrawalFeeBtc: { ...WITHDRAWAL_FEE_BTC },
  rebalanceEvery: REBALANCE_EVERY,
  risk: { ...RISK },
  rebalance: { ...REBALANCE, transferDelaySec: 45 },
  initialUsd: INITIAL_USD,
  initialBtc: INITIAL_BTC,
};

/** Fee efectivo (fracción) para un venue según modo y tier actuales. */
export function feeOf(p: EngineParams, ex: string): number {
  const table = p.maker ? p.makerFee : p.takerFee;
  return (table[ex] ?? 0.005) * p.feeMult;
}

/** Venues habilitados para detectar/operar. */
export function isActive(p: EngineParams, ex: string): boolean {
  return p.activeExchanges[ex] ?? true;
}

/** Clona los defaults (para reset y presets). */
export function freshDefaults(): EngineParams {
  return structuredClone(DEFAULT_PARAMS);
}

// --- Presets de estrategia: puntos de partida con narrativa clara ---
export type PresetId = "conservador" | "balanceado" | "agresivo" | "optimo";

export const PRESETS: { id: PresetId; label: string; hint: string; apply: (p: EngineParams) => EngineParams }[] = [
  {
    id: "conservador",
    label: "Conservador",
    hint: "Solo margen claro: umbral 5 bps, órdenes chicas, breaker sensible.",
    apply: (p) => ({
      ...p,
      minNetBps: 5,
      maxTradeBtc: 0.5,
      maxWalletFrac: 0.15,
      recheckTolBps: 2,
      risk: { ...p.risk, maxDrawdownUsd: 1500, maxConsecutiveLosses: 2 },
    }),
  },
  {
    id: "balanceado",
    label: "Balanceado",
    hint: "Los defaults: ejecuta cualquier neto positivo con riesgo moderado.",
    apply: (p) => ({
      ...p,
      minNetBps: DEFAULT_PARAMS.minNetBps,
      maxTradeBtc: DEFAULT_PARAMS.maxTradeBtc,
      maxWalletFrac: DEFAULT_PARAMS.maxWalletFrac,
      recheckTolBps: DEFAULT_PARAMS.recheckTolBps,
      risk: { ...DEFAULT_PARAMS.risk },
    }),
  },
  {
    id: "agresivo",
    label: "Agresivo",
    hint: "Volumen alto y tolerancia amplia: más fills, más deriva aceptada. (En el sweep de 5 h perdió $970 — amplificar trades sin filtro sangra en fees de rebalanceo.)",
    apply: (p) => ({
      ...p,
      minNetBps: 0,
      maxTradeBtc: 4,
      maxWalletFrac: 0.5,
      recheckTolBps: 12,
      risk: { ...p.risk, maxDrawdownUsd: 12000, maxConsecutiveLosses: 5 },
    }),
  },
  {
    id: "optimo",
    label: "Óptimo (sweep 5h)",
    hint: "Ganador del barrido sobre 5 h de mercado real: umbral 4 bps + sizing 50% (+$418 vs +$31 de los defaults). Calidad primero, tamaño después.",
    apply: (p) => ({
      ...p,
      minNetBps: 4,
      maxTradeBtc: DEFAULT_PARAMS.maxTradeBtc,
      maxWalletFrac: 0.5,
      recheckTolBps: 5,
    }),
  },
];

/**
 * Merge profundo de un objeto parcial persistido sobre los defaults.
 * Tolerante a esquemas viejos: claves desconocidas se descartan (venue
 * eliminado, campo renombrado), tipos que no coinciden o números no finitos
 * también, y las faltantes toman el default.
 */
export function mergeParams(saved: unknown): EngineParams {
  const base = freshDefaults();
  if (!saved || typeof saved !== "object") return base;
  const s = saved as Record<string, unknown>;
  const out = base as unknown as Record<string, unknown>;

  const validLeaf = (leaf: unknown, def: unknown) =>
    typeof leaf === typeof def && (typeof leaf !== "number" || Number.isFinite(leaf));

  for (const key of Object.keys(out)) {
    const val = s[key];
    if (val === undefined) continue;
    const def = out[key];
    if (typeof def === "object" && def !== null) {
      if (typeof val !== "object" || val === null) continue;
      const defObj = def as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...defObj };
      for (const [k, leaf] of Object.entries(val as Record<string, unknown>)) {
        if (k in defObj && validLeaf(leaf, defObj[k])) merged[k] = leaf;
      }
      out[key] = merged;
    } else if (validLeaf(val, def)) {
      out[key] = val;
    }
  }
  return out as unknown as EngineParams;
}

/** ¿Difiere de los defaults? (para el badge "personalizado" en la UI) */
export function isCustomized(p: EngineParams): boolean {
  return JSON.stringify(p) !== JSON.stringify(DEFAULT_PARAMS);
}

/** Cuenta de parámetros ajustables (para presumir la cifra en la UI/README). */
export function countTunables(p: EngineParams): number {
  let n = 0;
  const walk = (o: object) => {
    for (const v of Object.values(o)) {
      if (typeof v === "object" && v !== null) walk(v);
      else n += 1;
    }
  };
  walk(p);
  return n;
}
