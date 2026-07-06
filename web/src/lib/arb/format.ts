// Helpers de formato para la UI.

export const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export const fmtNum = (n: number, d = 4) => n.toLocaleString("en-US", { maximumFractionDigits: d });

export function fmtDuration(ms: number): string {
  // Clamp a ≥0: el reloj de la UI (nowTs) va un tick detrás de eventos recién
  // creados (p. ej. iniciar el laboratorio) y daría duraciones negativas.
  const s = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m ${s % 60}s`;
}
