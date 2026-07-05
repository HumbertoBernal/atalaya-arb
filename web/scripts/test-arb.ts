// Test de humo del motor con order books reales.
import { fetchAllBooks } from "../src/lib/arb/exchanges";
import { detectOpportunities, simulateExecution } from "../src/lib/arb/engine";
import { freshDefaults } from "../src/lib/arb/params";
import type { OrderBooks, Wallet } from "../src/lib/arb/types";
import { EXCHANGES } from "../src/lib/arb/config";

async function main() {
const books = await fetchAllBooks();
const map: OrderBooks = {};
for (const b of books) map[b.exchange] = b;

for (const mult of [1, 0.1, 0]) {
  const p = { ...freshDefaults(), feeMult: mult };
  const opps = detectOpportunities(map, p);
  const viable = opps.filter((o) => o.viable);
  console.log(`\n=== feeMult ${mult} — ${opps.length} oportunidades brutas, ${viable.length} viables ===`);
  for (const o of opps.slice(0, 3)) {
    console.log(
      `  ${o.buyEx}→${o.sellEx}: gross ${o.grossBps.toFixed(1)}bps, qty ${o.maxQty.toFixed(3)}, neto $${o.netProfit.toFixed(2)} ${o.viable ? "✓" : ""}`,
    );
  }
  if (viable.length) {
    const wallets: Record<string, Wallet> = {};
    for (const ex of EXCHANGES) wallets[ex] = { exchange: ex, usd: p.initialUsd, btc: p.initialBtc };
    const { trade } = simulateExecution(viable[0], map, wallets, p);
    if (trade)
      console.log(
        `  EJECUCIÓN: ${trade.qty.toFixed(4)} BTC, neto $${trade.netProfit.toFixed(2)}, parcial=${trade.partial}`,
      );
  }
}
}

main();
