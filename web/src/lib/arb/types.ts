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
  netPerBtc: number; // ganancia neta por BTC al tope de liquidez (con fees+slippage)
  netProfit: number; // ganancia neta total estimada para maxQty
  netBps: number; // margen neto en bps
  viable: boolean; // netProfit > 0
};

export type Fill = { price: number; qty: number; cost: number };

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
};

export type Wallet = { exchange: string; usd: number; btc: number };
