// Tipos del módulo de captura de funding (estrategia delta-neutral:
// long spot + short perp del mismo notional → cobrar funding cuando es
// positivo). Fase 1: SOLO backtest sobre datos históricos reales — cero
// dinero real hasta pasar los gates (backtest → paper → size mínimo).

/** Un periodo de funding liquidado (cada 8h en la mayoría de venues). */
export type FundingTick = {
  t: number; // timestamp ms de la liquidación
  rate: number; // fracción del notional (positivo = los longs pagan a los shorts)
  price?: number; // mark price al momento (si el venue lo reporta)
};

export type FundingBacktestParams = {
  capitalUsd: number; // capital total de la cuenta
  notionalFrac: number; // fracción del capital desplegada como notional cubierto
  entryAprPct: number; // entrar cuando el funding anualizado (media móvil) supera esto
  exitAprPct: number; // salir cuando cae por debajo de esto (histéresis)
  windowPeriods: number; // ventana de la media móvil, en periodos de funding
  roundTripCostPct: number; // costo TOTAL ida+vuelta, ambas patas (fees + slippage)
};

export type YearRow = {
  year: number;
  netUsd: number; // P&L neto del año (funding − fees)
  fundingUsd: number;
  feesUsd: number;
  timeInMarketPct: number;
  roundTrips: number;
  avgAprPct: number; // funding medio anualizado del año (del mercado, no de la estrategia)
};

export type FundingBacktestResult = {
  params: FundingBacktestParams;
  periods: number; // ticks de funding procesados
  periodsPerYear: number; // inferido del espaciado real de los datos
  fromTs: number;
  toTs: number;
  // --- Económica ---
  netUsd: number;
  fundingUsd: number; // funding cobrado (bruto)
  feesUsd: number; // costos de entrada/salida acumulados
  aprOnCapitalPct: number; // neto anualizado sobre el capital total
  // --- Actividad ---
  roundTrips: number;
  timeInMarketPct: number;
  maxDrawdownUsd: number; // caída máxima desde pico de equity
  byYear: YearRow[];
  equity: { t: number; usd: number }[]; // curva (muestreada) para graficar después
};
