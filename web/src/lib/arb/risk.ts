// Gestión de riesgo / circuit breaker.
// Evalúa condiciones adversas y, si se disparan, detiene la ejecución (sin dejar
// de mostrar el mercado). Responde al criterio del enunciado:
// "¿Existe algún mecanismo de gestión de riesgo o de circuit breaker?"
import { DEFAULT_PARAMS, type RiskParams } from "./params";
import type { OrderBook, Opportunity } from "./types";

export type RiskState = {
  tripped: boolean;
  hard: boolean; // trip por límite de PÉRDIDA (drawdown) → solo re-armado manual
  reasons: string[];
  maxBookAgeMs: number;
};

export function evaluateRisk(
  books: OrderBook[],
  opps: Opportunity[],
  pnl: number,
  peakPnl: number,
  now: number,
  cfg: RiskParams = DEFAULT_PARAMS.risk,
  consecutiveAborts = 0,
): RiskState {
  const reasons: string[] = [];
  const okBooks = books.filter((b) => b.ok);

  // 1) Datos stale: si el feed más fresco es muy viejo, no operamos a ciegas.
  const ages = okBooks.map((b) => now - b.ts);
  const maxAge = ages.length ? Math.max(...ages) : Infinity;
  if (!okBooks.length) {
    reasons.push("Sin feeds activos");
  } else if (maxAge > cfg.maxBookAgeMs) {
    reasons.push(`Datos stale (${(maxAge / 1000).toFixed(1)}s)`);
  }

  // 2) Spread anómalo: un bruto absurdamente grande suele ser dato corrupto.
  const anomalous = opps.find((o) => o.grossBps > cfg.maxGrossBps);
  if (anomalous) {
    reasons.push(`Spread anómalo ${anomalous.grossBps.toFixed(0)} bps (posible dato corrupto)`);
  }

  // 3) Drawdown: caída desde el pico de P&L por encima del límite. Es el único
  //    trip DURO: un límite de pérdida no se auto-rearma — exige decisión humana.
  const drawdown = peakPnl - pnl;
  const hard = drawdown > cfg.maxDrawdownUsd;
  if (hard) {
    reasons.push(`Drawdown ${drawdown.toFixed(0)} USD > límite`);
  }

  // 4) Abortos consecutivos: si la re-verificación mata N órdenes seguidas, el
  //    mercado se mueve más rápido que nuestra ejecución → parar y no perseguirlo.
  if (consecutiveAborts >= cfg.maxConsecutiveLosses) {
    reasons.push(`${consecutiveAborts} ejecuciones abortadas seguidas (mercado demasiado rápido)`);
  }

  return { tripped: reasons.length > 0, hard, reasons, maxBookAgeMs: maxAge };
}

/** Filtra oportunidades que individualmente parecen corruptas (spread absurdo). */
export function sanitizeOpportunities(
  opps: Opportunity[],
  maxGrossBps: number = DEFAULT_PARAMS.risk.maxGrossBps,
): Opportunity[] {
  return opps.filter((o) => o.grossBps <= maxGrossBps);
}
