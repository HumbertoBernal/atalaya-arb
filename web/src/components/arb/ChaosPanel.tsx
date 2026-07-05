"use client";

// Panel de escenarios adversos (modo caos): inyecta fallas SOLO en la capa de
// simulación para demostrar la robustez en vivo — cómo reaccionan el circuit
// breaker, el fallback REST y la re-verificación de ejecución. Responde al
// criterio del comité: "¿Cómo se comporta tu bot cuando una orden falla,
// cuando la liquidez es insuficiente o el mercado se mueve bruscamente?"
import { useState } from "react";
import { EXCHANGE_LABEL, EXCHANGES } from "@/lib/arb/config";
import type { ChaosState } from "@/lib/arb/chaos";

type Props = {
  chaos: ChaosState;
  chaosOn: boolean;
  now: number; // reloj del último tick (evita Date.now() en render)
  setChaos: (updater: (c: ChaosState) => ChaosState) => void;
  clearChaos: () => void;
};

const SHOCK_BPS = 200;
const SHOCK_SECS = 12;

export function ChaosPanel({ chaos, chaosOn, now, setChaos, clearChaos }: Props) {
  const [open, setOpen] = useState(false);
  const [shockVenue, setShockVenue] = useState<string>(EXCHANGES[1]);

  const shockLive = chaos.shockVenue !== null && now < chaos.shockUntil;

  const fire = (bps: number) =>
    setChaos((c) => ({
      ...c,
      shockVenue,
      shockBps: bps,
      shockUntil: Date.now() + SHOCK_SECS * 1000,
    }));

  return (
    <section
      className={`mb-6 rounded-xl border ${
        chaosOn ? "border-amber-700/70 bg-amber-950/10" : "border-neutral-800 bg-neutral-900/50"
      }`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-3 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <span className="text-amber-400">⚡</span> Escenarios adversos
          <span className="text-neutral-500 font-normal">· prueba la robustez en vivo</span>
          {chaosOn && (
            <span className="rounded-full border border-amber-700 bg-amber-950/50 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-300">
              caos activo
            </span>
          )}
        </span>
        <span className="text-neutral-500 text-xs font-mono">{open ? "▲ cerrar" : "▼ abrir"}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4">
          <p className="text-xs text-neutral-500">
            Las fallas se inyectan solo en la capa de simulación (el mercado real no se toca). Observa el circuit
            breaker, los abortos de ejecución y el fallback de feeds reaccionar.
          </p>

          {/* Venue caído */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-neutral-400 w-40">Tirar un venue:</span>
            {EXCHANGES.map((ex) => {
              const down = chaos.offline[ex] ?? false;
              return (
                <button
                  key={ex}
                  onClick={() => setChaos((c) => ({ ...c, offline: { ...c.offline, [ex]: !down } }))}
                  className={`px-2.5 py-1 rounded-full border text-xs transition-colors ${
                    down
                      ? "border-rose-700 bg-rose-950/40 text-rose-300"
                      : "border-neutral-700 text-neutral-400 hover:border-neutral-500"
                  }`}
                >
                  {down ? "☠ caído" : EXCHANGE_LABEL[ex]}
                  {down && ` · ${EXCHANGE_LABEL[ex]}`}
                </button>
              );
            })}
          </div>

          {/* Shock de precio */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-neutral-400 w-40">Shock de precio ({SHOCK_SECS}s):</span>
            <select
              value={shockVenue}
              onChange={(ev) => setShockVenue(ev.target.value)}
              className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 focus:border-amber-500 focus:outline-none"
            >
              {EXCHANGES.map((ex) => (
                <option key={ex} value={ex}>
                  {EXCHANGE_LABEL[ex]}
                </option>
              ))}
            </select>
            <button
              onClick={() => fire(-SHOCK_BPS)}
              className="px-2.5 py-1 rounded-full border border-rose-800 text-rose-300 text-xs hover:bg-rose-950/40 transition-colors"
            >
              ▼ −{SHOCK_BPS} bps
            </button>
            <button
              onClick={() => fire(SHOCK_BPS)}
              className="px-2.5 py-1 rounded-full border border-emerald-800 text-emerald-300 text-xs hover:bg-emerald-950/40 transition-colors"
            >
              ▲ +{SHOCK_BPS} bps
            </button>
            {shockLive && (
              <span className="text-amber-400 text-xs">
                ⚡ shock {chaos.shockBps > 0 ? "+" : ""}
                {chaos.shockBps} bps en {EXCHANGE_LABEL[chaos.shockVenue!]} — el breaker debería marcarlo como
                anómalo
              </span>
            )}
          </div>

          {/* Toggles */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-neutral-400 w-40">Condiciones de mercado:</span>
            <button
              onClick={() => setChaos((c) => ({ ...c, liquidityCrunch: !c.liquidityCrunch }))}
              className={`px-2.5 py-1 rounded-full border text-xs transition-colors ${
                chaos.liquidityCrunch
                  ? "border-amber-700 bg-amber-950/40 text-amber-300"
                  : "border-neutral-700 text-neutral-400 hover:border-neutral-500"
              }`}
            >
              🏜 Sequía de liquidez {chaos.liquidityCrunch ? "ON" : ""}
            </button>
            <button
              onClick={() => setChaos((c) => ({ ...c, freezeFeeds: !c.freezeFeeds }))}
              className={`px-2.5 py-1 rounded-full border text-xs transition-colors ${
                chaos.freezeFeeds
                  ? "border-amber-700 bg-amber-950/40 text-amber-300"
                  : "border-neutral-700 text-neutral-400 hover:border-neutral-500"
              }`}
            >
              🧊 Congelar feeds {chaos.freezeFeeds ? "ON (→ breaker por staleness)" : ""}
            </button>
          </div>

          {chaosOn && (
            <button
              onClick={clearChaos}
              className="px-3 py-1.5 rounded-lg border border-emerald-800 text-emerald-300 text-sm hover:bg-emerald-950/40 transition-colors"
            >
              ✓ Restaurar condiciones normales
            </button>
          )}
        </div>
      )}
    </section>
  );
}
