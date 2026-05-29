"""Motor cuant — API FastAPI.

Capa Python del Crypto Risk Copilot: ingesta, featurización, modelos,
backtesting. La app web (Next.js) consume estos endpoints.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from engine.backtest.walkforward import walk_forward_naive  # noqa: E402
from engine.features.build import build_features  # noqa: E402

CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "cache"

app = FastAPI(
    title="Crypto Risk Copilot — Engine",
    version="0.1.0",
    description="Motor cuant: ingesta, forecast, riesgo y backtest.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _load(coin: str, vs: str = "usd") -> pd.DataFrame:
    path = CACHE_DIR / f"coingecko_{coin}_{vs}.parquet"
    if not path.exists():
        raise HTTPException(404, f"Sin snapshot para {coin}/{vs}. Corre la ingesta primero.")
    return pd.read_parquet(path)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "engine"}


@app.get("/market/{coin}")
def market(coin: str, vs: str = "usd") -> dict:
    """Serie de precio/market cap/volumen del snapshot cacheado."""
    df = _load(coin, vs)
    df = df.dropna(subset=["price"])
    return {
        "coin": coin,
        "vs": vs,
        "n": len(df),
        "start": df["ts"].min().isoformat(),
        "end": df["ts"].max().isoformat(),
        "series": [
            {"ts": ts.isoformat(), "price": float(p), "volume": float(v) if pd.notna(v) else None}
            for ts, p, v in zip(df["ts"], df["price"], df.get("volume", pd.Series([None] * len(df))))
        ],
    }


@app.get("/analysis/{coin}")
def analysis(coin: str, vs: str = "usd") -> dict:
    """Features de régimen actuales + backtest walk-forward de baselines."""
    df = _load(coin, vs)
    feats = build_features(df)
    last = feats.dropna(subset=["log_ret"]).iloc[-1]

    res = walk_forward_naive(df["price"].dropna(), n_splits=5)
    return {
        "coin": coin,
        "regime": {
            "price": float(last["price"]),
            "log_ret": float(last["log_ret"]),
            "vol_7d": float(last["roll_std_7"]),
            "momentum_30d": float(last["mom_30"]),
            "drawdown_30d": float(last["drawdown_30"]),
            "regime": "alcista" if last["regime_bull"] == 1 else "bajista",
        },
        "backtest": [
            {"model": r.model, "mae": r.mae, "rmse": r.rmse, "n": r.n_preds}
            for r in res.values()
        ],
        "disclaimer": "Simulación educativa / demo; no usar para operar capital real.",
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
