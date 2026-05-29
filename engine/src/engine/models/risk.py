"""Modelo de riesgo: volatilidad condicional con GARCH(1,1).

A diferencia del precio (casi random walk), la *volatilidad* de crypto tiene
estructura robusta (volatility clustering): periodos turbulentos se agrupan.
GARCH la captura y permite forecast de riesgo + VaR — el verdadero valor del
copiloto.

Validación: comparamos la skill del GARCH para predecir la volatilidad
realizada futura contra un baseline de volatilidad constante (la histórica).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from arch import arch_model


@dataclass
class RiskResult:
    sigma_annualized: float       # volatilidad condicional actual (anualizada)
    var_95_1d: float              # Value-at-Risk 1 día al 95% (retorno, negativo)
    forecast_vol_7d: list[float]  # vol diaria pronosticada (próximos 7 días)
    garch_skill_vs_const: float   # 1 - mae_garch/mae_const sobre vol realizada


def _fit(returns_pct: np.ndarray):
    am = arch_model(returns_pct, vol="GARCH", p=1, q=1, mean="Zero", dist="t")
    return am.fit(disp="off")


def garch_risk(price: pd.Series) -> RiskResult:
    """Ajusta GARCH(1,1) a los retornos y deriva métricas de riesgo."""
    p = price.dropna()
    log_ret = np.log(p / p.shift(1)).dropna().to_numpy() * 100  # en %

    res = _fit(log_ret)
    cond_vol = res.conditional_volatility  # % diario
    sigma_now = float(cond_vol[-1]) / 100.0
    sigma_ann = sigma_now * np.sqrt(365)

    # VaR 95% 1d con cuantil normal (aprox): -1.645 * sigma
    var_95 = float(-1.645 * sigma_now)

    fc = res.forecast(horizon=7, reindex=False)
    fc_daily = np.sqrt(fc.variance.to_numpy().ravel()) / 100.0

    skill = _walk_forward_vol_skill(log_ret)

    return RiskResult(
        sigma_annualized=sigma_ann,
        var_95_1d=var_95,
        forecast_vol_7d=[float(x) for x in fc_daily],
        garch_skill_vs_const=skill,
    )


def _walk_forward_vol_skill(returns_pct: np.ndarray, n_splits: int = 4) -> float:
    """Skill del GARCH prediciendo |retorno| futuro vs vol constante histórica."""
    n = len(returns_pct)
    fold = n // (n_splits + 1)
    if fold < 20:
        return 0.0
    err_g, err_c = [], []
    for k in range(1, n_splits + 1):
        tr_end = fold * k
        train, test = returns_pct[:tr_end], returns_pct[tr_end : tr_end + fold]
        if len(test) == 0:
            continue
        try:
            res = _fit(train)
            fc = np.sqrt(res.forecast(horizon=len(test), reindex=False).variance.to_numpy().ravel())
        except Exception:
            continue
        const = np.full(len(test), np.std(train))
        realized = np.abs(test)  # proxy de vol realizada
        err_g.append(np.mean(np.abs(realized - fc)))
        err_c.append(np.mean(np.abs(realized - const)))
    if not err_g:
        return 0.0
    mae_g, mae_c = np.mean(err_g), np.mean(err_c)
    return float(1 - mae_g / mae_c) if mae_c else 0.0


if __name__ == "__main__":
    from pathlib import Path

    cache = Path(__file__).resolve().parents[4] / "data" / "cache"
    frame = pd.read_parquet(cache / "coingecko_bitcoin_usd.parquet")
    r = garch_risk(frame["price"])
    print("GARCH(1,1) — riesgo BTC/USD:")
    print(f"  Volatilidad anualizada actual : {r.sigma_annualized:.1%}")
    print(f"  VaR 95% 1d                    : {r.var_95_1d:.2%}")
    print(f"  Skill vs vol constante        : {r.garch_skill_vs_const:+.3f}")
    print(f"  Forecast vol 7d (diaria)      : {[f'{x:.2%}' for x in r.forecast_vol_7d]}")
