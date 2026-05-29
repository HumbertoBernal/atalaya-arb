"""Motor cuant — API FastAPI.

Capa Python del Crypto Risk Copilot: ingesta, featurización, modelos,
backtesting. La app web (Next.js) consume estos endpoints.
"""
from __future__ import annotations

from fastapi import FastAPI

app = FastAPI(
    title="Crypto Risk Copilot — Engine",
    version="0.1.0",
    description="Motor cuant: ingesta, forecast, riesgo y backtest.",
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "engine"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
