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
  backtest: { model: string; mae: number; rmse: number; n: number }[];
  disclaimer: string;
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${ENGINE_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Engine ${res.status}: ${path}`);
  return res.json() as Promise<T>;
}

export const getMarket = (coin: string) => get<MarketResponse>(`/market/${coin}`);
export const getAnalysis = (coin: string) => get<AnalysisResponse>(`/analysis/${coin}`);
