"use client";

// Panel de parametrización del motor (criterio clave del comité: profundidad
// y parametrización). Cada control edita EngineParams en runtime; el motor
// (funciones puras) recibe el objeto en el siguiente tick. Persiste en
// localStorage. Presets = puntos de partida de estrategia con narrativa.
import { useState } from "react";
import { EXCHANGE_LABEL, EXCHANGES } from "@/lib/arb/config";
import {
  countTunables,
  isCustomized,
  PRESETS,
  type EngineParams,
  type PresetId,
} from "@/lib/arb/params";

type Props = {
  params: EngineParams;
  patchParams: (patch: Partial<EngineParams>) => void;
  applyPreset: (id: PresetId) => void;
  resetParams: () => void;
};

export function ConfigPanel({ params, patchParams, applyPreset, resetParams }: Props) {
  const [open, setOpen] = useState(false);
  const custom = isCustomized(params);
  const activeCount = EXCHANGES.filter((ex) => params.activeExchanges[ex] ?? true).length;

  const toggleExchange = (ex: string) => {
    const on = params.activeExchanges[ex] ?? true;
    if (on && activeCount <= 2) return; // el arbitraje cross-exchange necesita ≥2 venues
    patchParams({ activeExchanges: { ...params.activeExchanges, [ex]: !on } });
  };

  return (
    <section className="mb-6 rounded-xl border border-neutral-800 bg-neutral-900/50">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-3 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <span className="text-cyan-400">⚙</span> Parámetros del motor
          <span className="text-neutral-500 font-normal">· {countTunables(params)} ajustables en runtime</span>
          {custom && (
            <span className="rounded-full border border-cyan-700 bg-cyan-950/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-cyan-300">
              personalizado
            </span>
          )}
        </span>
        <span className="text-neutral-500 text-xs font-mono">{open ? "▲ cerrar" : "▼ abrir"}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-5">
          {/* Presets */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-neutral-400">Presets:</span>
            {PRESETS.map((pr) => (
              <button
                key={pr.id}
                onClick={() => applyPreset(pr.id)}
                title={pr.hint}
                className="px-2.5 py-1.5 rounded-full border border-neutral-700 text-neutral-300 hover:border-cyan-500 hover:text-cyan-200 transition-colors"
              >
                {pr.label}
              </button>
            ))}
            <button
              onClick={resetParams}
              className="px-2.5 py-1.5 rounded-full border border-neutral-800 text-neutral-500 hover:border-neutral-500 hover:text-neutral-300 transition-colors"
            >
              ↺ Restaurar defaults
            </button>
          </div>

          {/* Estrategia */}
          <Group title="Estrategia" hint="Cuándo y cuánto ejecuta el bot.">
            <Num
              label="Umbral mínimo neto"
              suffix="bps"
              value={params.minNetBps}
              step={0.5}
              min={0}
              onChange={(v) => patchParams({ minNetBps: v })}
              tip="Margen neto mínimo (tras fees, slippage y fricciones) para ejecutar. 0 = cualquier neto positivo."
            />
            <Num
              label="Máx. BTC por orden"
              suffix="BTC"
              value={params.maxTradeBtc}
              step={0.1}
              min={0.01}
              onChange={(v) => patchParams({ maxTradeBtc: v })}
              tip="Tope de volumen por operación — control de riesgo básico."
            />
            <Num
              label="Tolerancia de deriva"
              suffix="bps"
              value={params.recheckTolBps}
              step={1}
              min={0}
              onChange={(v) => patchParams({ recheckTolBps: v })}
              tip="Cuánto puede caer el neto entre detección y ejecución antes de abortar la orden (re-verificación)."
            />
            <Num
              label="Prob. de fill (maker)"
              value={params.makerFillProb}
              step={0.05}
              min={0}
              max={1}
              onChange={(v) => patchParams({ makerFillProb: Math.min(1, v) })}
              tip="Probabilidad de que una orden límite se llene antes de que el spread se cierre."
            />
          </Group>

          {/* Exchanges activos */}
          <Group title="Exchanges activos" hint={`El universo de venues que el bot considera (mínimo 2). Activos: ${activeCount}/${EXCHANGES.length}.`}>
            <div className="col-span-full flex flex-wrap gap-2">
              {EXCHANGES.map((ex) => {
                const on = params.activeExchanges[ex] ?? true;
                return (
                  <button
                    key={ex}
                    onClick={() => toggleExchange(ex)}
                    className={`px-3 py-1.5 rounded-full border text-sm transition-colors ${
                      on
                        ? "border-emerald-600 bg-emerald-950/40 text-emerald-200"
                        : "border-neutral-700 text-neutral-500 hover:border-neutral-500"
                    }`}
                  >
                    {on ? "●" : "○"} {EXCHANGE_LABEL[ex]}
                  </button>
                );
              })}
            </div>
          </Group>

          {/* Fees por exchange */}
          <Group title="Fees por exchange" hint="Editables — el tier (Retail…Maker 0%) multiplica estos valores base.">
            <div className="col-span-full overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-neutral-500">
                  <tr>
                    <th className="text-left py-1 font-normal">Venue</th>
                    <th className="text-right font-normal">Taker %</th>
                    <th className="text-right font-normal">Maker %</th>
                    <th className="text-right font-normal">Retiro BTC</th>
                    <th className="text-right font-normal">Latencia ms</th>
                  </tr>
                </thead>
                <tbody>
                  {EXCHANGES.map((ex) => (
                    <tr key={ex} className="border-t border-neutral-800/60">
                      <td className="py-1 text-neutral-300">{EXCHANGE_LABEL[ex]}</td>
                      <td className="text-right">
                        <MiniNum
                          value={(params.takerFee[ex] ?? 0) * 100}
                          step={0.05}
                          onChange={(v) => patchParams({ takerFee: { ...params.takerFee, [ex]: v / 100 } })}
                        />
                      </td>
                      <td className="text-right">
                        <MiniNum
                          value={(params.makerFee[ex] ?? 0) * 100}
                          step={0.05}
                          onChange={(v) => patchParams({ makerFee: { ...params.makerFee, [ex]: v / 100 } })}
                        />
                      </td>
                      <td className="text-right">
                        <MiniNum
                          value={params.withdrawalFeeBtc[ex] ?? 0}
                          step={0.00005}
                          onChange={(v) => patchParams({ withdrawalFeeBtc: { ...params.withdrawalFeeBtc, [ex]: v } })}
                        />
                      </td>
                      <td className="text-right">
                        <MiniNum
                          value={params.latencyMs[ex] ?? 150}
                          step={10}
                          onChange={(v) => patchParams({ latencyMs: { ...params.latencyMs, [ex]: v } })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Group>

          {/* Riesgo */}
          <Group title="Riesgo / circuit breaker" hint="Cuándo el bot se detiene solo.">
            <Num
              label="Drawdown máximo"
              suffix="USD"
              value={params.risk.maxDrawdownUsd}
              step={500}
              min={100}
              onChange={(v) => patchParams({ risk: { ...params.risk, maxDrawdownUsd: v } })}
              tip="Caída desde el pico de P&L que detiene la ejecución."
            />
            <Num
              label="Edad máx. de datos"
              suffix="ms"
              value={params.risk.maxBookAgeMs}
              step={500}
              min={1000}
              onChange={(v) => patchParams({ risk: { ...params.risk, maxBookAgeMs: v } })}
              tip="Con datos más viejos que esto, el bot no opera a ciegas."
            />
            <Num
              label="Spread anómalo"
              suffix="bps"
              value={params.risk.maxGrossBps}
              step={10}
              min={10}
              onChange={(v) => patchParams({ risk: { ...params.risk, maxGrossBps: v } })}
              tip="Un bruto mayor a esto se trata como dato corrupto y no se opera."
            />
            <Num
              label="Abortos consecutivos"
              value={params.risk.maxConsecutiveLosses}
              step={1}
              min={1}
              onChange={(v) => patchParams({ risk: { ...params.risk, maxConsecutiveLosses: Math.round(v) } })}
              tip="Órdenes abortadas seguidas (mercado más rápido que la ejecución) que disparan el breaker."
            />
          </Group>

          {/* Rebalanceo */}
          <Group title="Rebalanceo de inventario" hint="Transferencias dirigidas entre venues cuando uno se agota.">
            <Num
              label="Mínimo USD por venue"
              suffix="USD"
              value={params.rebalance.minUsd}
              step={500}
              min={0}
              onChange={(v) => patchParams({ rebalance: { ...params.rebalance, minUsd: v } })}
            />
            <Num
              label="Mínimo BTC por venue"
              suffix="BTC"
              value={params.rebalance.minBtc}
              step={0.05}
              min={0}
              onChange={(v) => patchParams({ rebalance: { ...params.rebalance, minBtc: v } })}
            />
            <Num
              label="Fee de red BTC"
              suffix="BTC"
              value={params.rebalance.btcNetworkFee}
              step={0.0001}
              min={0}
              onChange={(v) => patchParams({ rebalance: { ...params.rebalance, btcNetworkFee: v } })}
              tip="Costo on-chain por transferencia entre venues; se descuenta del P&L."
            />
            <Num
              label="Confirmación on-chain"
              suffix="s"
              value={params.rebalance.transferDelaySec}
              step={15}
              min={0}
              onChange={(v) => patchParams({ rebalance: { ...params.rebalance, transferDelaySec: v } })}
              tip="Mientras la transferencia confirma, esos fondos NO están disponibles para operar (escala de demo)."
            />
          </Group>

          {/* Capital + fricciones globales */}
          <Group title="Capital y fricciones" hint="El capital inicial aplica al presionar Reset.">
            <Num
              label="USD inicial por venue"
              suffix="USD"
              value={params.initialUsd}
              step={5000}
              min={0}
              onChange={(v) => patchParams({ initialUsd: v })}
            />
            <Num
              label="BTC inicial por venue"
              suffix="BTC"
              value={params.initialBtc}
              step={0.5}
              min={0}
              onChange={(v) => patchParams({ initialBtc: v })}
            />
            <Num
              label="Volatilidad BTC"
              suffix="%/s"
              value={params.btcVolPerSec * 100}
              step={0.001}
              min={0}
              onChange={(v) => patchParams({ btcVolPerSec: v / 100 })}
              tip="Para el costo de adverse selection: cuánto puede moverse el precio durante la latencia."
            />
            <Num
              label="Retiro amortizado cada"
              suffix="ops"
              value={params.rebalanceEvery}
              step={5}
              min={1}
              onChange={(v) => patchParams({ rebalanceEvery: Math.max(1, Math.round(v)) })}
              tip="Entre cuántas operaciones se reparte el costo de un retiro on-chain."
            />
          </Group>
        </div>
      )}
    </section>
  );
}

/* ---------- primitivas ---------- */

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-lg border border-neutral-800/80 p-4">
      <legend className="px-2 text-xs uppercase tracking-[0.2em] text-neutral-400">{title}</legend>
      {hint && <p className="text-xs text-neutral-500 mb-3">{hint}</p>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{children}</div>
    </fieldset>
  );
}

/**
 * Input numérico con estado BORRADOR: se puede teclear libremente ("2.", vacío,
 * un valor a medias) y el valor se valida/clampa y comitea al salir del campo
 * o con Enter. Un input controlado directo secuestraría el tipeo: el clamp de
 * `min` corrompería valores a medio escribir y el re-render del tick (1.2s)
 * pisaría el borrador.
 */
function useDraftNumber(value: number, onCommit: (v: number) => void, min?: number, max?: number) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(+value.toFixed(6));
  const commit = () => {
    if (draft === null) return;
    const v = parseFloat(draft);
    if (Number.isFinite(v)) {
      let x = v;
      if (min !== undefined) x = Math.max(min, x);
      if (max !== undefined) x = Math.min(max, x);
      onCommit(x);
    }
    setDraft(null); // descarta borradores inválidos y vuelve al valor vigente
  };
  return { shown, setDraft, commit };
}

const commitOnEnter = (ev: React.KeyboardEvent<HTMLInputElement>) => {
  if (ev.key === "Enter") ev.currentTarget.blur();
};

function Num({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  suffix,
  tip,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  tip?: string;
}) {
  const { shown, setDraft, commit } = useDraftNumber(value, onChange, min, max);
  return (
    <label className="block" title={tip}>
      <span className="block text-xs text-neutral-400 mb-1">
        {label}
        {tip && <span className="ml-1 cursor-help text-neutral-600">ⓘ</span>}
      </span>
      <span className="flex items-center gap-1.5">
        <input
          type="number"
          value={shown}
          step={step}
          min={min}
          max={max}
          onChange={(ev) => setDraft(ev.target.value)}
          onBlur={commit}
          onKeyDown={commitOnEnter}
          className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-neutral-100 focus:border-cyan-500 focus:outline-none"
        />
        {suffix && <span className="text-xs text-neutral-500 whitespace-nowrap">{suffix}</span>}
      </span>
    </label>
  );
}

function MiniNum({ value, onChange, step }: { value: number; onChange: (v: number) => void; step: number }) {
  const { shown, setDraft, commit } = useDraftNumber(value, onChange, 0);
  return (
    <input
      type="number"
      value={shown}
      step={step}
      min={0}
      onChange={(ev) => setDraft(ev.target.value)}
      onBlur={commit}
      onKeyDown={commitOnEnter}
      className="w-24 rounded border border-neutral-800 bg-neutral-950 px-1.5 py-1 text-right font-mono text-xs text-neutral-200 focus:border-cyan-500 focus:outline-none"
    />
  );
}
