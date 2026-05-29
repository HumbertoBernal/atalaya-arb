"""Optimización de portafolio: Markowitz (media-varianza) y CVaR.

- Markowitz: maximiza retorno ajustado por riesgo (mu·w - gamma·wᵀΣw), long-only.
- CVaR: minimiza la pérdida esperada en la cola (Rockafellar-Uryasev), más
  alineado con riesgo de cola que la varianza.

Ambos son convexos y se resuelven con CVXPY. Se construyen sobre retornos
diarios reales de los snapshots cacheados.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cvxpy as cp
import numpy as np
import pandas as pd

CACHE_DIR = Path(__file__).resolve().parents[4] / "data" / "cache"


@dataclass
class Portfolio:
    method: str
    weights: dict[str, float]
    exp_return_annual: float
    vol_annual: float
    sharpe: float


def load_returns(coins: list[str], vs: str = "usd") -> pd.DataFrame:
    """Matriz de retornos diarios alineados por fecha para varios activos."""
    series = {}
    for c in coins:
        path = CACHE_DIR / f"coingecko_{c}_{vs}.parquet"
        if not path.exists():
            continue
        df = pd.read_parquet(path)[["ts", "price"]].copy()
        df["date"] = pd.to_datetime(df["ts"]).dt.date
        df = df.groupby("date")["price"].last()
        series[c] = df
    prices = pd.DataFrame(series).dropna()
    return np.log(prices / prices.shift(1)).dropna()


def _stats(w: np.ndarray, mu: np.ndarray, cov: np.ndarray) -> tuple[float, float, float]:
    r = float(mu @ w) * 365
    v = float(np.sqrt(w @ cov @ w)) * np.sqrt(365)
    sharpe = r / v if v else 0.0
    return r, v, sharpe


def markowitz(returns: pd.DataFrame, gamma: float = 5.0) -> Portfolio:
    mu = returns.mean().to_numpy()
    cov = returns.cov().to_numpy()
    n = len(mu)
    w = cp.Variable(n)
    obj = cp.Maximize(mu @ w - gamma * cp.quad_form(w, cp.psd_wrap(cov)))
    prob = cp.Problem(obj, [cp.sum(w) == 1, w >= 0])
    prob.solve()
    weights = np.clip(w.value, 0, None)
    weights = weights / weights.sum()
    r, v, s = _stats(weights, mu, cov)
    return Portfolio("markowitz", dict(zip(returns.columns, weights.round(4))), r, v, s)


def cvar_portfolio(returns: pd.DataFrame, alpha: float = 0.95) -> Portfolio:
    """Minimiza el CVaR (pérdida media en la cola peor (1-alpha)). Rockafellar-Uryasev."""
    R = returns.to_numpy()  # escenarios históricos (T x n)
    T, n = R.shape
    mu = returns.mean().to_numpy()
    cov = returns.cov().to_numpy()

    w = cp.Variable(n)
    z = cp.Variable(T, nonneg=True)  # excesos de pérdida sobre VaR
    var = cp.Variable()  # VaR (umbral)
    losses = -R @ w  # pérdida por escenario
    cvar = var + (1.0 / (T * (1 - alpha))) * cp.sum(z)
    constraints = [z >= losses - var, cp.sum(w) == 1, w >= 0]
    cp.Problem(cp.Minimize(cvar), constraints).solve()

    weights = np.clip(w.value, 0, None)
    weights = weights / weights.sum()
    r, v, s = _stats(weights, mu, cov)
    return Portfolio("cvar", dict(zip(returns.columns, weights.round(4))), r, v, s)


def optimize(coins: list[str]) -> dict:
    returns = load_returns(coins)
    if returns.shape[1] < 2:
        return {"error": "Se necesitan >=2 activos con snapshot."}
    mk = markowitz(returns)
    cv = cvar_portfolio(returns)
    return {
        "assets": list(returns.columns),
        "n_obs": int(returns.shape[0]),
        "markowitz": _to_dict(mk),
        "cvar": _to_dict(cv),
    }


def _to_dict(p: Portfolio) -> dict:
    return {
        "method": p.method,
        "weights": {k: float(v) for k, v in p.weights.items()},
        "exp_return_annual": p.exp_return_annual,
        "vol_annual": p.vol_annual,
        "sharpe": p.sharpe,
    }


if __name__ == "__main__":
    out = optimize(["bitcoin", "ethereum", "solana", "binancecoin"])
    print(f"Activos: {out['assets']} ({out['n_obs']} obs)\n")
    for m in ("markowitz", "cvar"):
        p = out[m]
        print(f"[{m}] Sharpe={p['sharpe']:.2f}  ret={p['exp_return_annual']:.1%}  vol={p['vol_annual']:.1%}")
        print("  pesos:", {k: f"{v:.0%}" for k, v in p["weights"].items()})
