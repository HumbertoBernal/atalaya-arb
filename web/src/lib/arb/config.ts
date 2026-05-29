// Configuración de exchanges: fees taker públicos aproximados (documentados como
// supuestos en el README). Valores conservadores del tier minorista.
export const EXCHANGES = ["coinbase", "kraken", "bitstamp", "gemini"] as const;
export type ExchangeId = (typeof EXCHANGES)[number];

export const TAKER_FEE: Record<string, number> = {
  coinbase: 0.006, // 0.60% Advanced Trade tier base (conservador)
  kraken: 0.0026, // 0.26%
  bitstamp: 0.004, // 0.40%
  gemini: 0.004, // 0.40% (API/ActiveTrader)
};

export const EXCHANGE_LABEL: Record<string, string> = {
  coinbase: "Coinbase",
  kraken: "Kraken",
  bitstamp: "Bitstamp",
  gemini: "Gemini",
};

// Tope de notional por operación simulada (gestión de riesgo / circuit breaker simple).
export const MAX_TRADE_BTC = 1.5;

// Saldos iniciales por exchange (USD y BTC pre-posicionados para arbitraje).
export const INITIAL_USD = 100_000;
export const INITIAL_BTC = 2;
