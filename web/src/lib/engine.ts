// Cliente del motor cuant (FastAPI). El ENGINE_URL vive solo en el servidor.
const ENGINE_URL = process.env.ENGINE_URL ?? "http://127.0.0.1:8000";

export type MarketPoint = { ts: string; price: number; volume: number | null };

export type MarketResponse = {
  coin: string;
  vs: string;
  n: number;
  start: string;
  end: string;
  series: MarketPoint[];
};

export type AnalysisResponse = {
  coin: string;
  regime: {
    price: number;
    log_ret: number;
    vol_7d: number;
    momentum_30d: number;
    drawdown_30d: number;
    regime: string;
  };
  forecast: {
    horizon_7d: number[];
    skill_vs_naive: number;
    models: { model: string; mae: number; rmse: number }[];
  } | null;
  risk: {
    sigma_annualized: number;
    var_95_1d: number;
    forecast_vol_7d: number[];
    garch_skill_vs_const: number;
  } | null;
  backtest: { model: string; mae: number; rmse: number; n: number }[];
  report?: string;
  disclaimer: string;
};

import snapshot from "@/data/snapshot.json";

// Intenta el engine vivo; si no responde (p. ej. en producción sin engine
// hosteado), cae al snapshot precomputado. Regla de oro: precomputar lo pesado.
export type PortfolioLeg = {
  method: string;
  weights: Record<string, number>;
  exp_return_annual: number;
  vol_annual: number;
  sharpe: number;
};

export type PortfolioResponse = {
  assets: string[];
  n_obs: number;
  markowitz: PortfolioLeg;
  cvar: PortfolioLeg;
};

async function get<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${ENGINE_URL}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) throw new Error(`Engine ${res.status}`);
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

export const getMarket = (coin: string) =>
  get<MarketResponse>(`/market/${coin}`, snapshot.market as MarketResponse);
export const getAnalysis = (coin: string) =>
  get<AnalysisResponse>(`/analysis/${coin}`, snapshot.analysis as AnalysisResponse);
export const getPortfolio = () =>
  get<PortfolioResponse>(`/portfolio`, (snapshot as { portfolio: PortfolioResponse }).portfolio);
