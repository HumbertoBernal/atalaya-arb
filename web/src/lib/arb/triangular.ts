// Arbitraje triangular intra-exchange: explota inconsistencias entre tres pares
// (USD, BTC, ETH) sin mover fondos entre exchanges. Mencionado en el enunciado
// como estrategia "más sofisticada".
//
// Ciclo directo:  USD → BTC → ETH → USD
// Ciclo inverso:  USD → ETH → BTC → USD
// Cada paso paga fee taker. Si el producto de las conversiones supera 1, hay arb.

export type TriQuote = { bid: number; ask: number };
export type TriBooks = { btcUsd: TriQuote; ethUsd: TriQuote; ethBtc: TriQuote };

export type TriResult = {
  direction: "USD→BTC→ETH→USD" | "USD→ETH→BTC→USD";
  finalPerUsd: number; // USD final por cada 1 USD inicial
  netBps: number; // (finalPerUsd - 1) en bps
  viable: boolean;
};

export function detectTriangular(b: TriBooks, fee: number): TriResult[] {
  const f = 1 - fee; // factor tras fee taker
  const out: TriResult[] = [];

  // Directo: compramos BTC (ask), compramos ETH con BTC (ask ETH/BTC), vendemos ETH (bid ETH/USD)
  {
    const btc = (1 / b.btcUsd.ask) * f;
    const eth = (btc / b.ethBtc.ask) * f;
    const usd = eth * b.ethUsd.bid * f;
    out.push(mk("USD→BTC→ETH→USD", usd));
  }
  // Inverso: compramos ETH (ask), vendemos ETH por BTC (bid ETH/BTC), vendemos BTC (bid BTC/USD)
  {
    const eth = (1 / b.ethUsd.ask) * f;
    const btc = eth * b.ethBtc.bid * f;
    const usd = btc * b.btcUsd.bid * f;
    out.push(mk("USD→ETH→BTC→USD", usd));
  }
  return out;
}

function mk(direction: TriResult["direction"], finalPerUsd: number): TriResult {
  return {
    direction,
    finalPerUsd,
    netBps: (finalPerUsd - 1) * 10_000,
    viable: finalPerUsd > 1,
  };
}
