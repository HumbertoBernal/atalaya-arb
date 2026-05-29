# Plan ejecutable — Coding Challenge Mexico 2026 (48h)

> Objetivo: **ganar**. Reto full-stack individual, 48h, premio $1M MXN, tema financiero/crypto (inferido).
> Stack: Next.js+TS+Tailwind/shadcn · Supabase+Prisma+pgvector · Python 3.12+FastAPI · Vercel AI SDK · pnpm.
> Tesis de producto: **Crypto Risk Copilot** — entender riesgo/régimen/decisión, no "predecir el mercado".

## Estado del brief

⚠️ **El plan vive sobre supuestos del deep-research report, no sobre el enunciado oficial.**
El sitio es una SPA y no expone el brief por fetch. En cuanto llegue el brief real:
1. Correr el *prompt de desambiguación* → fijar problema, persona, KPI primario.
2. Confirmar/corregir vertical, datos y criterios del jurado.
3. Ajustar SOLO la capa de dominio; la fundación (fases 0-2) no cambia.

## Principio rector

**Demo-first + todo lo pesado se precalcula.** Una vertical completa de punta a punta vence a un
notebook brillante con app rota. Primera demo desplegada **antes de la mitad del tiempo**.

---

## Fases

### Fase 0 — Fundación brief-INDEPENDIENTE (h0–h10) · empezar YA
- [ ] Monorepo: `web/` (Next.js) + `engine/` (FastAPI) + `data/` (caché snapshots).
- [ ] Scaffold Next.js App Router + TS + Tailwind + shadcn/ui. Layout, nav, tema.
- [ ] **Deploy inicial a Vercel** (URL viva con placeholder). Criterio done: la URL abre.
- [ ] Entorno Python 3.12 con `uv`: pandas, numpy, statsmodels, scikit-learn, prophet, cvxpy, fastapi, uvicorn.
- [ ] Ingesta CoinGecko (OHLCV/market cap) + FRED (macro) → snapshots en `data/`.
- [ ] Esquema DB (ERD del reporte) en Supabase + Prisma (`db push` en prototipo).
- [ ] `.env.example` con todas las keys.

### Fase 1 — Datos + baselines (h10–h20)
- [ ] Limpieza + auditoría de datos (prompt de auditoría). Detectar leakage/gaps/outliers.
- [ ] Featurización: retornos log, rolling mean/std, volumen rel, momentum, drawdown, proxy de régimen.
- [ ] **Baseline ingenuo/persistencia** + partición temporal walk-forward. Primer gráfico fuera de muestra.
- [ ] Persistir feature_snapshots y resultados.

### Fase 2 — Modelo principal + riesgo (h20–h34)
- [ ] Forecast interpretable: SARIMAX **o** Prophet (1 y 7 días, o 1h/24h).
- [ ] Riesgo: GARCH (volatilidad condicional).
- [ ] Clasificador direccional tabular simple (opcional).
- [ ] Portafolio: Markowitz + CVaR con CVXPY.
- [ ] **Backtest walk-forward** con fees/slippage. Métricas: MSE/MAE, AUC, Sharpe, max drawdown.
- [ ] Benchmark vs modelo principal en una vista.

### Fase 3 — Capa IA + visualización (h34–h44)
- [ ] AI SDK + proveedor LLM. Prompts estructurados (JSON contracts del reporte).
- [ ] Reportes: explicación financiera + reporte ejecutivo + señales sandbox (con disclaimer).
- [ ] Dashboard final con Plotly: ≤6 gráficas clave.
- [ ] pgvector para memoria documental (explicaciones/FAQ) — opcional si hay tiempo.

### Fase 4 — Cierre (h44–h48)
- [ ] Hardening: nada crítico depende de llamadas pesadas en vivo (todo cacheado/persistido).
- [ ] Seed reproducible + README + script de demo.
- [ ] Narrativa de jurado: tesis de valor, 2 hallazgos cuantitativos, limitaciones honestas, próximos pasos.
- [ ] Disclaimers legales (activos virtuales MX): evitar copy de "asesor de inversión".

---

## Checkpoints "done"

| Hora | Entregable visible | Criterio |
|------|--------------------|----------|
| h10  | App desplegada + nav | La URL abre y no rompe el flujo |
| h20  | Ingesta + baseline + 1er gráfico | Hay una métrica temporal fuera de muestra |
| h34  | Modelo + backtest | Se muestra benchmark vs modelo principal |
| h44  | Reportes LLM + dashboard | El sistema explica qué hizo y sus límites |
| h48  | Demo pulida | Todo crítico cacheado/persistido |

## Riesgos a vigilar
- **Overfitting**: walk-forward + benchmarks; no reportar solo la mejor variante.
- **Dependencia de API en vivo**: snapshots locales como contingencia.
- **Scope creep**: LSTM/TFT solo como challenger opcional, nunca camino crítico.
- **Lenguaje regulatorio MX**: etiquetar todo como simulación/demo educativa.
