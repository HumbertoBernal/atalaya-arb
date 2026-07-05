// Tipos compartidos del motor de arbitraje.

export type Level = { price: number; qty: number };

export type OrderBook = {
  exchange: string;
  bids: Level[]; // desc por precio (mejor bid primero)
  asks: Level[]; // asc por precio (mejor ask primero)
  ts: number; // epoch ms del fetch
  latencyMs: number; // cuánto tardó el fetch (proxy de latencia)
  ok: boolean;
  error?: string;
};

export type OrderBooks = Record<string, OrderBook>;

// Oportunidad detectada: comprar en buyEx, vender en sellEx.
export type Opportunity = {
  buyEx: string;
  sellEx: string;
  buyAsk: number; // mejor ask en buyEx
  sellBid: number; // mejor bid en sellEx
  grossSpread: number; // sellBid - buyAsk (por BTC, bruto)
  grossBps: number; // spread bruto en puntos básicos sobre buyAsk
  maxQty: number; // BTC ejecutables limitados por liquidez visible
  feesCost: number; // USD en comisiones (taker, ambos exchanges)
  latencyCost: number; // USD de adverse selection por latencia de red
  withdrawalCost: number; // USD de retiro amortizado (rebalanceo)
  netPerBtc: number; // ganancia neta por BTC (todo incluido)
  netProfit: number; // ganancia neta total (fees + slippage + latencia + retiro)
  netBps: number; // margen neto en bps
  viable: boolean; // netProfit > 0
};

export type Trade = {
  id: string;
  ts: number;
  buyEx: string;
  sellEx: string;
  qty: number; // BTC efectivamente ejecutados (puede ser parcial)
  requestedQty: number;
  avgBuyPrice: number; // precio promedio de compra (con slippage)
  avgSellPrice: number; // precio promedio de venta (con slippage)
  buyFee: number; // USD
  sellFee: number; // USD
  grossProfit: number; // USD
  netProfit: number; // USD (neto de fees)
  partial: boolean;
  status: "filled" | "aborted"; // aborted = la re-verificación mató la orden
  driftBps?: number; // cuánto se movió el neto entre detección y ejecución
  abortReason?: string;
};

export type Wallet = { exchange: string; usd: number; btc: number };

// Transferencia de rebalanceo entre venues (BTC viaja on-chain con delay).
export type Transfer = {
  id: string;
  from: string;
  to: string;
  asset: "usd" | "btc";
  amount: number; // lo que RECIBE el destino (el fee de red ya se quemó al salir)
  feeBtc: number; // fee de red pagado (0 para USD)
  sentTs: number;
  arriveTs: number; // cuándo se acredita en el destino
};
