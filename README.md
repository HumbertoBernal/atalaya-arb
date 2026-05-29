# Crypto Risk Copilot — Coding Challenge MX 2026

**Demo en vivo:** https://atalaya-rosy.vercel.app

Un copiloto de **riesgo y decisión financiera** para criptoactivos. Tesis central:
no prometemos predecir el precio (es casi un *random walk*), sino **gestionar riesgo,
entender régimen y construir portafolios** con métodos interpretables y validación honesta.

> ⚠️ Simulación educativa / demo. No es asesoría de inversión ni está listo para operar capital real.

## Por qué este enfoque gana

Un "bot de trading" opaco impresiona en superficie pero se rompe ante un jurado técnico.
Este producto, en cambio, demuestra **juicio cuantitativo**: reporta cuándo un modelo
*no* aporta valor, valida fuera de muestra y separa lo predecible (riesgo) de lo que no
(precio). Cubre una vertical full-stack completa de punta a punta.

## Los cuatro pilares

| Pilar | Implementación | Hallazgo honesto |
|-------|----------------|------------------|
| **Ingesta** | CoinGecko (4 activos) → caché Parquet | 366 días reales de OHLCV/market cap |
| **Modelado** | baselines + ARIMA + GARCH(1,1) | Precio ≈ random walk (ARIMA skill +0.7% vs naive) |
| **Backtest** | walk-forward rolling-origin (5 folds) | Métricas por fold, siempre vs baseline ingenuo |
| **Explicación** | reporte ejecutivo determinista + AI SDK | Funciona sin LLM; se enriquece con Claude/OpenAI si hay key |

Extra: **portafolio** Markowitz (media-varianza) vs CVaR (riesgo de cola) con CVXPY.

## Arquitectura

```
CoinGecko ──► engine/ingest ──► data/cache (Parquet)
                                      │
                 ┌────────────────────┼─────────────────────┐
            features (sin leakage)  ARIMA/GARCH        portfolio (CVXPY)
                 └──────────► engine/main.py (FastAPI) ◄──────┘
                                      │  /market /analysis /portfolio
                                      ▼
              web (Next.js SSR) ──► BFF (lib/engine.ts) ──► dashboard
                                      │  fallback: snapshot.json precomputado
                                      ▼
                            lib/llm.ts (AI SDK, opcional) ──► reporte enriquecido
```

- **`web/`** — Next.js 16, TypeScript, Tailwind, recharts, Vercel AI SDK. Desplegado en Vercel.
- **`engine/`** — FastAPI + Python 3.12 (pandas, statsmodels, arch, scikit-learn, cvxpy). Gestionado con `uv`.
- **`db/`** — Supabase Postgres: 10 tablas (ERD), pgvector, RLS server-side. Migraciones en `db/migrations/`.
- **`data/cache/`** — snapshots Parquet para reproducibilidad y demo sin dependencia de API en vivo.

## Cómo correr (local)

```bash
# 1) Motor cuant
cd engine
uv run uvicorn main:app --port 8000        # http://127.0.0.1:8000/health

# 2) App web (otra terminal)
cd web
pnpm install
ENGINE_URL=http://127.0.0.1:8000 pnpm dev   # http://localhost:3000
```

Sin el engine, el web cae al snapshot precomputado (`web/src/data/snapshot.json`) y
sigue mostrando datos reales — la regla de oro: **todo lo pesado se precalcula**.

### Variables de entorno (`web/.env.local`)

```
NEXT_PUBLIC_SUPABASE_URL=...        # configurado
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
ENGINE_URL=http://127.0.0.1:8000
ANTHROPIC_API_KEY=                  # opcional: activa reporte con Claude
OPENAI_API_KEY=                     # opcional: activa reporte con OpenAI
```

## Guion de demo (90 segundos)

1. **Régimen** — tarjetas: precio, régimen (alcista/bajista), volatilidad, drawdown.
2. **Gráfica** — un año de precio real.
3. **Riesgo (GARCH)** — vol anualizada + VaR 95% + forecast de volatilidad. *"El valor está aquí, no en adivinar el precio."*
4. **Forecast honesto** — ARIMA apenas bate al naive → prueba de no-overfitting.
5. **Portafolio** — Markowitz vs CVaR: el conservador concentra, el otro diversifica.
6. **Reporte ejecutivo** — narrativa auto-generada con limitaciones explícitas.

## Validación y honestidad

- **Walk-forward** (no entrenar con futuro), siempre contra baseline ingenuo.
- Reportamos skill negativo/marginal cuando ocurre — sin inflar.
- Disclaimers regulatorios (activos virtuales MX): lenguaje de simulación, no de asesoría.

## Limitaciones

- Horizonte y muestra acotados (1 año diario); resultados varían por régimen.
- GARCH/ARIMA sensibles al periodo; no prometen alpha de timing.
- Portafolio sobre 4 activos como sandbox, no universo completo.

## Próximos pasos (con más tiempo)

Persistencia de corridas a Supabase (service role), challenger profundo (LSTM/TFT) como
contraste, embeddings en pgvector para memoria documental, y más horizontes de backtest.
