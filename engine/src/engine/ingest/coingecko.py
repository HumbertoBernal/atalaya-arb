"""Ingesta de datos de mercado desde CoinGecko (API pública gratuita).

Endpoint usado: /coins/{id}/market_chart — precios, market cap y volumen.
No requiere API key en el tier público. Si COINGECKO_API_KEY está presente,
se envía como header para el plan Demo/Pro.

Los datos se cachean localmente en data/cache para no depender del API
durante la demo (regla de oro: todo lo pesado se precalcula).
"""
from __future__ import annotations

import os
from pathlib import Path

import httpx
import pandas as pd

BASE_URL = "https://api.coingecko.com/api/v3"
CACHE_DIR = Path(__file__).resolve().parents[4] / "data" / "cache"


def _headers() -> dict[str, str]:
    key = os.getenv("COINGECKO_API_KEY")
    return {"x-cg-demo-api-key": key} if key else {}


def fetch_market_chart(
    coin_id: str = "bitcoin",
    vs_currency: str = "usd",
    days: int = 365,
) -> pd.DataFrame:
    """Descarga la serie de precio/market cap/volumen y devuelve un DataFrame.

    Columnas: ts (UTC), price, market_cap, volume.
    """
    url = f"{BASE_URL}/coins/{coin_id}/market_chart"
    params = {"vs_currency": vs_currency, "days": str(days)}

    with httpx.Client(timeout=30.0, headers=_headers()) as client:
        resp = client.get(url, params=params)
        resp.raise_for_status()
        payload = resp.json()

    def _series(key: str, name: str) -> pd.DataFrame:
        rows = payload.get(key, [])
        df = pd.DataFrame(rows, columns=["ts_ms", name])
        df["ts"] = pd.to_datetime(df["ts_ms"], unit="ms", utc=True)
        return df[["ts", name]]

    prices = _series("prices", "price")
    caps = _series("market_caps", "market_cap")
    vols = _series("total_volumes", "volume")

    df = prices.merge(caps, on="ts", how="outer").merge(vols, on="ts", how="outer")
    df = df.sort_values("ts").reset_index(drop=True)
    df.attrs["coin_id"] = coin_id
    df.attrs["vs_currency"] = vs_currency
    return df


def save_snapshot(df: pd.DataFrame, coin_id: str, vs_currency: str = "usd") -> Path:
    """Persiste el snapshot como Parquet en data/cache."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / f"coingecko_{coin_id}_{vs_currency}.parquet"
    df.to_parquet(path, index=False)
    return path


if __name__ == "__main__":
    frame = fetch_market_chart("bitcoin", "usd", days=365)
    out = save_snapshot(frame, "bitcoin", "usd")
    print(f"Filas: {len(frame)} | rango: {frame['ts'].min()} -> {frame['ts'].max()}")
    print(f"Snapshot: {out}")
