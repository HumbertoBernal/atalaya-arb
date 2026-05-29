import { PriceChart } from "@/components/PriceChart";
import { getAnalysis, getMarket } from "@/lib/engine";

export const dynamic = "force-dynamic";

const COIN = "bitcoin";

function pct(x: number) {
  return `${(x * 100).toFixed(2)}%`;
}

export default async function Home() {
  let market, analysis, error: string | null = null;
  try {
    [market, analysis] = await Promise.all([getMarket(COIN), getAnalysis(COIN)]);
  } catch (e) {
    error = e instanceof Error ? e.message : "Error desconocido";
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 px-6 py-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">Crypto Risk Copilot</h1>
          <p className="text-neutral-400 mt-1">
            Riesgo, régimen y decisión financiera — no predicción ciega del mercado.
          </p>
        </header>

        {error ? (
          <div className="rounded-lg border border-amber-700 bg-amber-950/40 p-4 text-amber-200">
            <p className="font-semibold">Motor cuant no disponible</p>
            <p className="text-sm mt-1 text-amber-300/80">{error}</p>
            <p className="text-sm mt-2">
              Arranca el engine: <code className="bg-black/40 px-1 rounded">cd engine && uv run uvicorn main:app --port 8000</code>
            </p>
          </div>
        ) : (
          <>
            <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
              <Card label="Precio (BTC)" value={`$${analysis!.regime.price.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
              <Card label="Régimen" value={analysis!.regime.regime} accent={analysis!.regime.regime === "alcista"} />
              <Card label="Volatilidad 7d" value={pct(analysis!.regime.vol_7d)} />
              <Card label="Drawdown 30d" value={pct(analysis!.regime.drawdown_30d)} negative />
            </section>

            <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 mb-8">
              <h2 className="text-lg font-semibold mb-4">
                BTC/USD — {market!.n} días ({market!.start.slice(0, 10)} → {market!.end.slice(0, 10)})
              </h2>
              <PriceChart data={market!.series} />
            </section>

            {analysis!.risk && (
              <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 mb-8">
                <h2 className="text-lg font-semibold mb-1">Riesgo (GARCH 1,1)</h2>
                <p className="text-sm text-neutral-400 mb-4">
                  El precio es casi un random walk; la <strong>volatilidad</strong> sí tiene estructura
                  predecible. Aquí está el valor del copiloto: gestionar riesgo, no adivinar precio.
                </p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <Card label="Volatilidad anualizada" value={pct(analysis!.risk.sigma_annualized)} />
                  <Card label="VaR 95% (1 día)" value={pct(analysis!.risk.var_95_1d)} negative />
                  <Card
                    label="Vol. pronosticada 7d (prom)"
                    value={pct(
                      analysis!.risk.forecast_vol_7d.reduce((a, b) => a + b, 0) /
                        analysis!.risk.forecast_vol_7d.length,
                    )}
                  />
                </div>
              </section>
            )}

            {analysis!.forecast && (
              <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 mb-8">
                <h2 className="text-lg font-semibold mb-1">Forecast de precio (ARIMA) — honesto</h2>
                <p className="text-sm text-neutral-400 mb-3">
                  Skill vs naive (random walk):{" "}
                  <span className={analysis!.forecast.skill_vs_naive > 0 ? "text-emerald-400" : "text-rose-400"}>
                    {(analysis!.forecast.skill_vs_naive * 100).toFixed(2)}%
                  </span>
                  . Un skill cercano a 0 confirma que el precio diario es casi impredecible —
                  reportarlo sin inflar es metodológicamente correcto.
                </p>
                <p className="text-sm text-neutral-300">
                  Proyección 7d:{" "}
                  {analysis!.forecast.horizon_7d
                    .map((v) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`)
                    .join(" → ")}
                </p>
              </section>
            )}

            <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 mb-6">
              <h2 className="text-lg font-semibold mb-1">Backtest walk-forward (baselines)</h2>
              <p className="text-sm text-neutral-400 mb-4">
                Error fuera de muestra (5 folds). El modelo principal deberá batir <code>naive</code>.
              </p>
              <table className="w-full text-sm">
                <thead className="text-neutral-400 border-b border-neutral-800">
                  <tr>
                    <th className="text-left py-2">Modelo</th>
                    <th className="text-right">MAE</th>
                    <th className="text-right">RMSE</th>
                    <th className="text-right">n</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis!.backtest.map((b) => (
                    <tr key={b.model} className="border-b border-neutral-800/50">
                      <td className="py-2 font-mono">{b.model}</td>
                      <td className="text-right">${b.mae.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                      <td className="text-right">${b.rmse.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                      <td className="text-right text-neutral-400">{b.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <p className="text-xs text-neutral-500">{analysis!.disclaimer}</p>
          </>
        )}
      </div>
    </main>
  );
}

function Card({
  label,
  value,
  accent,
  negative,
}: {
  label: string;
  value: string;
  accent?: boolean;
  negative?: boolean;
}) {
  const color = accent ? "text-emerald-400" : negative ? "text-rose-400" : "text-neutral-100";
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
      <p className="text-xs text-neutral-400 uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-semibold mt-1 capitalize ${color}`}>{value}</p>
    </div>
  );
}
