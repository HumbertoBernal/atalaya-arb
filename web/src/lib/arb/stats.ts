// Utilidades estadísticas para arbitraje estadístico (mean-reversion del spread).

export type ZScore = { mean: number; std: number; z: number; n: number };

/** Media, desviación y z-score del último valor sobre una ventana. */
export function zScore(series: number[]): ZScore {
  const n = series.length;
  if (n < 2) return { mean: series[0] ?? 0, std: 0, z: 0, n };
  const mean = series.reduce((a, b) => a + b, 0) / n;
  const variance = series.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  const last = series[n - 1];
  const z = std > 0 ? (last - mean) / std : 0;
  return { mean, std, z, n };
}

/** Buffer circular de tamaño fijo. */
export function pushCapped(arr: number[], value: number, cap: number): number[] {
  const next = [...arr, value];
  if (next.length > cap) next.shift();
  return next;
}
