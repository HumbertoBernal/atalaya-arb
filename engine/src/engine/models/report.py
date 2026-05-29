"""Capa de explicación: reporte ejecutivo a partir de los resultados reales.

Sigue la estructura del 'Prompt de explicación financiera' del reporte de
research: problema, datos, método, validación, métricas, limitaciones, utilidad.

Es DETERMINISTA (no requiere LLM): construye la narrativa directamente desde
los números. El web puede luego enriquecerlo con un LLM si hay API key, pero
nunca depende de ello para funcionar. Honestidad ante todo: si el modelo no
bate al baseline, el reporte lo dice.
"""
from __future__ import annotations


def _pct(x: float) -> str:
    return f"{x * 100:.2f}%"


def build_report(analysis: dict) -> str:
    """Genera un reporte ejecutivo en Markdown desde el dict de /analysis."""
    coin = analysis.get("coin", "activo")
    reg = analysis.get("regime", {})
    fc = analysis.get("forecast")
    risk = analysis.get("risk")
    bt = analysis.get("backtest", [])

    price = reg.get("price")
    regime = reg.get("regime", "indeterminado")

    # Lectura honesta del forecast
    if fc and fc.get("skill_vs_naive") is not None:
        skill = fc["skill_vs_naive"]
        if skill > 0.02:
            fc_line = f"El modelo ARIMA aporta valor sobre el baseline naive (skill {_pct(skill)} en MAE)."
        elif skill > 0:
            fc_line = (
                f"El ARIMA apenas supera al naive (skill {_pct(skill)}): el precio diario se comporta "
                "casi como un random walk. Lo reportamos sin inflar — es lo metodológicamente correcto."
            )
        else:
            fc_line = (
                "El ARIMA no supera al baseline naive fuera de muestra. El precio diario es esencialmente "
                "impredecible a este horizonte; el valor está en el riesgo, no en el punto."
            )
    else:
        fc_line = "Forecast no disponible en esta corrida."

    # Riesgo
    if risk:
        risk_line = (
            f"La volatilidad anualizada actual es {_pct(risk['sigma_annualized'])} y el VaR 95% a 1 día "
            f"es {_pct(risk['var_95_1d'])}. A diferencia del precio, la volatilidad sí tiene estructura "
            "(volatility clustering), y es donde el copiloto entrega valor real de gestión de riesgo."
        )
    else:
        risk_line = "Modelo de riesgo no disponible en esta corrida."

    bt_line = "; ".join(
        f"{b['model']} MAE ${b['mae']:,.0f}" for b in bt
    ) or "sin backtest"

    return f"""## Qué problema resolvimos
Un copiloto de **riesgo y decisión** para {coin}: en vez de prometer predicción de precio,
ayuda a entender régimen de mercado, riesgo de cola y la (escasa) predecibilidad del precio.

## Qué datos usamos
Serie histórica de mercado (OHLCV / market cap) de CoinGecko, cacheada localmente para
reproducibilidad. Precio actual de referencia: ${price:,.0f}. Régimen actual: **{regime}**.

## Qué método elegimos y por qué
Cascada interpretable: baselines (naive/mean7) como piso, ARIMA como forecast de precio,
GARCH(1,1) para volatilidad condicional, y features de régimen. Priorizamos interpretabilidad
y honestidad sobre complejidad — clave en 48h y ante un jurado técnico.

## Cómo validamos
Walk-forward (rolling origin) con múltiples folds, comparando siempre contra un baseline ingenuo.
Sin esto, cualquier métrica es sospechosa de overfitting.

## Qué dicen las métricas
{fc_line}
{risk_line}
Backtest de baselines: {bt_line}.

## Qué limitaciones tiene
- El precio diario es casi un random walk; no prometemos alpha de timing.
- GARCH y ARIMA son sensibles al periodo; resultados varían por régimen.
- Es una simulación educativa/demo, no asesoría de inversión.

## Por qué esta solución es útil en producción
Entrega métricas de riesgo estándar (vol condicional, VaR), un régimen interpretable y un
pipeline reproducible end-to-end (datos → modelo → backtest → reporte), desplegable y auditable.
"""


if __name__ == "__main__":
    import json
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    import main  # type: ignore

    rep = build_report(main.analysis("bitcoin"))
    print(rep)
    print("\n--- JSON-safe:", len(json.dumps(rep)), "chars ---")
