"""Featurización de series financieras.

Tres bloques (del deep-research report): retornos/lags, volatilidad/liquidez,
y contexto/régimen. Todo calculable en pandas, sin leakage (solo pasado).
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def build_features(df: pd.DataFrame, price_col: str = "price") -> pd.DataFrame:
    """Añade features sobre un DataFrame con columnas ts y price[, volume].

    Importante: todas las ventanas usan solo información pasada (rolling),
    así que no introducen leakage del futuro.
    """
    out = df.copy().sort_values("ts").reset_index(drop=True)
    p = out[price_col]

    # --- Retornos y lags ---
    out["log_ret"] = np.log(p / p.shift(1))
    out["ret_1"] = p.pct_change(1)
    out["ret_7"] = p.pct_change(7)

    # --- Volatilidad / liquidez ---
    out["roll_mean_7"] = p.rolling(7).mean()
    out["roll_std_7"] = out["log_ret"].rolling(7).std()
    out["roll_std_30"] = out["log_ret"].rolling(30).std()
    if "volume" in out.columns:
        out["vol_rel"] = out["volume"] / out["volume"].rolling(30).mean()

    # --- Momentum / régimen ---
    out["mom_30"] = p / p.shift(30) - 1
    roll_max = p.rolling(30, min_periods=1).max()
    out["drawdown_30"] = p / roll_max - 1
    out["regime_bull"] = (p > p.rolling(50, min_periods=1).mean()).astype(int)

    return out


if __name__ == "__main__":
    from pathlib import Path

    cache = Path(__file__).resolve().parents[4] / "data" / "cache"
    frame = pd.read_parquet(cache / "coingecko_bitcoin_usd.parquet")
    feats = build_features(frame)
    cols = ["ts", "price", "log_ret", "roll_std_7", "mom_30", "drawdown_30", "regime_bull"]
    print(feats[cols].tail(5).to_string(index=False))
    print(f"\nFeatures: {[c for c in feats.columns if c not in frame.columns]}")
