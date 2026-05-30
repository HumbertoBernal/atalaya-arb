// Configuración de exchanges: fees taker públicos aproximados (documentados como
// supuestos en el README). Valores conservadores del tier minorista.
export const EXCHANGES = ["coinbase", "kraken", "bitstamp", "gemini", "bitfinex"] as const;
export type ExchangeId = (typeof EXCHANGES)[number];

// --- Timing / ventanas (centralizado para que todos los tunables vivan aquí) ---
export const POLL_MS = 1200; // bucle principal de detección
export const TRIANGULAR_POLL_MS = 2500; // poll del arbitraje triangular
export const L2_FRESHNESS_MS = 5000; // edad máxima para confiar en un libro L2
export const WS_RECONNECT_MS = 3000; // backoff de reconexión de WebSocket
export const DET_WINDOW = 100; // muestras para percentiles de latencia
export const SPREAD_WINDOW = 120; // muestras para z-score del spread
export const EQUITY_WINDOW = 150; // puntos en la curva de P&L
export const TRADES_MAX = 60; // historial de trades en memoria

export const TAKER_FEE: Record<string, number> = {
  coinbase: 0.006, // 0.60% Advanced Trade tier base (conservador)
  kraken: 0.0026, // 0.26%
  bitstamp: 0.004, // 0.40%
  gemini: 0.004, // 0.40% (API/ActiveTrader)
  bitfinex: 0.002, // 0.20% taker
};

// Fees MAKER (órdenes límite): mucho menores que taker. Un retail que postea
// límites paga esto — y por eso el arbitraje puede ser viable incluso en retail.
// El costo: la orden puede NO ejecutarse antes de que el spread se cierre.
export const MAKER_FEE: Record<string, number> = {
  coinbase: 0.004, // 0.40% maker base
  kraken: 0.0016, // 0.16%
  bitstamp: 0.003, // 0.30%
  gemini: 0.002, // 0.20%
  bitfinex: 0.001, // 0.10% maker
};

// Probabilidad de que una orden límite (maker) se llene antes de que el spread
// se cierre. Modela el riesgo de ejecución del modo maker.
export const MAKER_FILL_PROB = 0.55;

export const EXCHANGE_LABEL: Record<string, string> = {
  coinbase: "Coinbase",
  kraken: "Kraken",
  bitstamp: "Bitstamp",
  gemini: "Gemini",
  bitfinex: "Bitfinex",
};

// Tope de notional por operación simulada (gestión de riesgo / circuit breaker simple).
export const MAX_TRADE_BTC = 1.5;

// Saldos iniciales por exchange (USD y BTC pre-posicionados para arbitraje).
export const INITIAL_USD = 100_000;
export const INITIAL_BTC = 2;

// --- Costos de retiro (withdrawal fees) on-chain, en BTC, por exchange ---
// El arbitraje con inventario pre-posicionado no retira por operación, pero hay
// que rebalancear periódicamente. Modelamos el costo amortizado por operación.
export const WITHDRAWAL_FEE_BTC: Record<string, number> = {
  coinbase: 0.0,     // Coinbase absorbe el fee de red en muchos casos
  kraken: 0.00002,   // ~fee de red BTC
  bitstamp: 0.00005,
  gemini: 0.0,       // Gemini ofrece retiros gratuitos limitados
  bitfinex: 0.0004,  // ~fee de red BTC de Bitfinex
};
// Cada cuántas operaciones se amortiza un retiro (rebalanceo).
export const REBALANCE_EVERY = 25;

// --- Rebalanceo automático de inventario ---
// Cuando un exchange se queda sin USD o sin BTC, esa ruta de arbitraje muere.
// Las mesas reales rebalancean inventario entre venues (pagando fees de red).
export const REBALANCE = {
  minUsd: 5_000,        // si el USD de un venue baja de esto → rebalancear
  minBtc: 0.1,          // si el BTC de un venue baja de esto → rebalancear
  btcNetworkFee: 0.0003, // fee de red por transferencia BTC entre venues
};

// --- Latencia de red estimada por exchange (ms) para adverse selection ---
export const NETWORK_LATENCY_MS: Record<string, number> = {
  coinbase: 120,
  kraken: 150,
  bitstamp: 180,
  gemini: 140,
  bitfinex: 160,
};
// Volatilidad intradía aprox. de BTC por segundo (fracción), para estimar
// cuánto puede moverse el precio en contra durante la ventana de latencia.
export const BTC_VOL_PER_SEC = 0.00012; // ~0.012%/s (≈ 60% anualizado)

// --- Parámetros de gestión de riesgo / circuit breaker ---
export const RISK = {
  maxBookAgeMs: 6000,        // datos más viejos que esto = stale → halt
  maxGrossBps: 150,          // spread bruto > esto = probable dato corrupto → ignorar
  maxConsecutiveLosses: 3,   // (en sim no debería pasar; defensivo)
  maxDrawdownUsd: 5000,      // caída desde el pico de P&L que dispara halt
};

// --- Pares para arbitraje triangular (intra-exchange) ---
// Ciclo: USD → BTC → ETH → USD (y a la inversa).
export const TRIANGULAR = {
  exchange: "coinbase",
  legs: { btcUsd: "BTC-USD", ethUsd: "ETH-USD", ethBtc: "ETH-BTC" },
};
