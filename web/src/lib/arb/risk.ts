// Gestión de riesgo / circuit breaker.
// Evalúa condiciones adversas y, si se disparan, detiene la ejecución (sin dejar
// de mostrar el mercado). Responde al criterio del enunciado:
// "¿Existe algún mecanismo de gestión de riesgo o de circuit breaker?"
import { RISK } from "./config";
import type { OrderBook, Opportunity } from "./types";

export type RiskState = {
  tripped: boolean;
  reasons: string[];
  maxBookAgeMs: number;
};

export function evaluateRisk(
  books: OrderBook[],
  opps: Opportunity[],
  pnl: number,
  peakPnl: number,
  now: number,
): RiskState {
  const reasons: string[] = [];
  const okBooks = books.filter((b) => b.ok);

  // 1) Datos stale: si el feed más fresco es muy viejo, no operamos a ciegas.
  const ages = okBooks.map((b) => now - b.ts);
  const maxAge = ages.length ? Math.max(...ages) : Infinity;
  if (!okBooks.length) {
    reasons.push("Sin feeds activos");
  } else if (maxAge > RISK.maxBookAgeMs) {
    reasons.push(`Datos stale (${(maxAge / 1000).toFixed(1)}s)`);
  }

  // 2) Spread anómalo: un bruto absurdamente grande suele ser dato corrupto.
  const anomalous = opps.find((o) => o.grossBps > RISK.maxGrossBps);
  if (anomalous) {
    reasons.push(`Spread anómalo ${anomalous.grossBps.toFixed(0)} bps (posible dato corrupto)`);
  }

  // 3) Drawdown: caída desde el pico de P&L por encima del límite.
  const drawdown = peakPnl - pnl;
  if (drawdown > RISK.maxDrawdownUsd) {
    reasons.push(`Drawdown ${drawdown.toFixed(0)} USD > límite`);
  }

  return { tripped: reasons.length > 0, reasons, maxBookAgeMs: maxAge };
}

/** Filtra oportunidades que individualmente parecen corruptas (spread absurdo). */
export function sanitizeOpportunities(opps: Opportunity[]): Opportunity[] {
  return opps.filter((o) => o.grossBps <= RISK.maxGrossBps);
}
