"""Validación walk-forward (rolling origin) con baselines ingenuos.

Responde la pregunta del jurado: ¿el modelo aporta valor sobre un baseline
trivial, fuera de muestra? Sin esto, cualquier métrica es sospechosa.

Baselines:
- naive: el último valor observado (random walk) -> pred_{t+1} = y_t
- mean7: media móvil de 7 pasos

Métricas: MAE y RMSE por fold y agregadas.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd


@dataclass
class WalkForwardResult:
    model: str
    mae: float
    rmse: float
    n_preds: int
    fold_mae: list[float] = field(default_factory=list)


def _metrics(y_true: np.ndarray, y_pred: np.ndarray) -> tuple[float, float]:
    err = y_true - y_pred
    mae = float(np.mean(np.abs(err)))
    rmse = float(np.sqrt(np.mean(err**2)))
    return mae, rmse


def walk_forward_naive(
    series: pd.Series,
    n_splits: int = 5,
    horizon: int = 1,
) -> dict[str, WalkForwardResult]:
    """Walk-forward expandiendo el origen, comparando baselines.

    En cada fold se 'entrena' con el pasado y se predice el siguiente bloque.
    Los baselines no requieren ajuste, pero respetan el orden temporal.
    """
    s = series.dropna().reset_index(drop=True)
    n = len(s)
    fold_size = n // (n_splits + 1)
    if fold_size <= horizon:
        raise ValueError("Serie demasiado corta para el número de splits/horizonte.")

    preds_naive, preds_mean, truths = [], [], []
    fold_mae_naive: list[float] = []

    for k in range(1, n_splits + 1):
        train_end = fold_size * k
        test_end = min(train_end + fold_size, n)
        train, test = s[:train_end], s[train_end:test_end]
        if len(test) == 0:
            continue

        # naive: último valor de train se proyecta sobre el bloque test
        p_naive = np.full(len(test), train.iloc[-1])
        # mean7: media de los últimos 7 de train
        p_mean = np.full(len(test), train.iloc[-7:].mean())

        y = test.to_numpy()
        preds_naive.extend(p_naive); preds_mean.extend(p_mean); truths.extend(y)
        fold_mae_naive.append(_metrics(y, p_naive)[0])

    y_true = np.array(truths)
    mae_n, rmse_n = _metrics(y_true, np.array(preds_naive))
    mae_m, rmse_m = _metrics(y_true, np.array(preds_mean))

    return {
        "naive": WalkForwardResult("naive", mae_n, rmse_n, len(y_true), fold_mae_naive),
        "mean7": WalkForwardResult("mean7", mae_m, rmse_m, len(y_true)),
    }


if __name__ == "__main__":
    from pathlib import Path

    cache = Path(__file__).resolve().parents[4] / "data" / "cache"
    frame = pd.read_parquet(cache / "coingecko_bitcoin_usd.parquet")
    res = walk_forward_naive(frame["price"], n_splits=5)
    print("Walk-forward (BTC/USD precio, 5 folds):")
    for name, r in res.items():
        print(f"  {name:6s}  MAE={r.mae:,.2f}  RMSE={r.rmse:,.2f}  n={r.n_preds}")
    print("\nNota: baselines de referencia. El modelo principal debe batir 'naive'.")
