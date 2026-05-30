# Atalaya — Bot de Arbitraje de Bitcoin

**Demo en vivo:** https://atalaya-arb.vercel.app

Sistema de trading que **detecta oportunidades de arbitraje de BTC en tiempo real** entre múltiples
exchanges y **simula su ejecución** neta de fees y slippage. "Atalaya" = torre de vigía: el sistema
vigila divergencias de precio entre mercados y actúa sobre las rentables.

> Simulación educativa / demo. No opera capital real.

## El problema

BTC se transa en cientos de exchanges independientes; sus precios divergen constantemente. Cuando el
**ask** de un exchange es menor que el **bid** de otro, existe arbitraje. Pero una oportunidad rentable
en bruto puede ser negativa tras **fees, slippage y liquidez** — y ahí está la verdadera dificultad.

## Cómo funciona

```
Exchanges (Coinbase, Kraken, Bitstamp, Gemini, Bitfinex)
   │  WebSocket (CB/KR/BS/BF, top-of-book en vivo)  │  REST (profundidad)
   ▼                                                ▼
LiveFeed (cliente)                          /api/orderbooks · /api/triangular
   │  mejor bid/ask sub-segundo                     │  server-side (evita CORS/geo)
   └───────────────► merge (WS top + REST depth) ◄──┘
        ▼
Cliente (React, ~1.2s + push WS)
   ├─ detectOpportunities()  ── cross-exchange ask<bid, ranking por neto
   ├─ optimalArb()           ── tamaño óptimo por profitabilidad MARGINAL
   │                            (recorre el book → slippage y fills parciales)
   ├─ frictionCosts()        ── adverse selection por latencia + retiro amortizado
   ├─ evaluateRisk()         ── circuit breaker (stale / spread anómalo / drawdown)
   ├─ detectTriangular()     ── ciclos intra-exchange USD/BTC/ETH
   ├─ simulateExecution()    ── respeta saldos de wallet, fills parciales
   └─ P&L acumulado + historial + balances (estado en el navegador)
```

### Capacidades

- **5 venues USD principales**: Coinbase, Kraken, Bitstamp, Gemini, Bitfinex.
- **Order book L2 completo por WebSocket** (Bitstamp, Kraken, Bitfinex, Gemini): se mantiene el libro
  entero en tiempo real (snapshot + deltas), con reconexión, guarda de libro-cruzado y **fallback a REST**
  si un feed cae. Coinbase por REST + ticker WS (su L2 exige auth). Sizing/slippage usan la profundidad L2.
- **Modo Maker / Taker**: ejecución inmediata (taker) o por órdenes límite (maker, fees menores, viable
  en retail) con haircut por probabilidad de fill (riesgo de ejecución).
- **Panel de métricas**: latencia de detección p50/p99, throughput WS (msgs/seg), frescura de datos
  y latencia de fetch del server — el criterio #1 (velocidad) medido, no afirmado.
- **Cálculo neto completo**: fees taker por exchange + slippage (order book real) + **adverse selection
  por latencia de red** + **withdrawal fee amortizado** (rebalanceo).
- **Circuit breaker**: detiene la ejecución ante datos stale, spread anómalo (dato corrupto) o drawdown.
- **Arbitraje triangular** intra-exchange (Coinbase USD/BTC/ETH), ambas direcciones del ciclo.
- **Matriz de spreads** (heatmap exchange × exchange) con el neto en bps de cada combinación.
- **Arbitraje estadístico**: z-score del mayor spread vs su media móvil (señal de mean-reversion).
- **Analítica de sesión**: tiempo activo, oportunidades vistas, viables, capture rate, volumen, mejor trade.
- **Tests**: `pnpm test` (13 casos del motor, deterministas).

### Decisiones técnicas clave

- **Simulador en el cliente + fetch server-side.** El navegador mantiene el estado (wallets, P&L,
  historial) y hace polling a un Route Handler que trae los order books. Así la demo **funciona en vivo
  para el jurado sin depender de un backend con estado** ni de credenciales, y evita CORS/bloqueos geo.
- **Tamaño óptimo por profitabilidad marginal.** En vez de ejecutar un volumen fijo, `optimalArb`
  recorre asks y bids nivel por nivel y ejecuta **mientras el ingreso marginal de venta (neto de fee)
  supere al costo marginal de compra**. Esto incorpora slippage y órdenes parciales de forma nativa y
  maximiza la ganancia neta sin operar volumen no rentable.
- **Net-first.** Toda oportunidad se evalúa neta de fees taker (por exchange) y slippage real. Las que
  son positivas en bruto pero negativas en neto se marcan y **no se ejecutan**.
- **Tier de fees configurable.** Retail / Pro / VIP / Maker. Con fees retail el arbitraje BTC/USD casi
  nunca es neto-positivo (mercados eficientes); a fees HFT aparecen ejecuciones — exactamente por qué el
  arbitraje real es un juego de baja latencia y alto volumen.
- **Gestión de riesgo.** Tope de notional por operación (`MAX_TRADE_BTC`), fills parciales por liquidez
  y por saldo de wallet, y rechazo de operaciones no rentables.

## Exchanges y fees

Order books públicos de **Coinbase, Kraken, Bitstamp, Gemini y Bitfinex** (BTC/USD, sin API key). Fees
taker aproximados y públicos por exchange (en `src/lib/arb/config.ts`), documentados como supuestos.

## Estructura

```
web/src/
  app/api/orderbooks/route.ts   # BFF: fetch paralelo de order books
  app/api/triangular/route.ts   # BFF: 3 pares de Coinbase para triangular
  app/page.tsx                  # render del dashboard
  components/arb/
    ArbDashboard.tsx  # UI tiempo real (polling, KPIs, tablas, P&L, métricas)
    SpreadMatrix.tsx  # heatmap exchange × exchange
  lib/arb/
    exchanges.ts   # conectores REST + normalización
    livefeed.ts    # feeds WebSocket top-of-book (cliente) + reconexión
    l2book.ts      # order book L2 completo por WebSocket (snapshot + deltas)
    engine.ts      # detección, optimalArb, fricción, simulación (puro, testeable)
    risk.ts        # circuit breaker
    triangular.ts  # arbitraje triangular intra-exchange
    rebalance.ts   # rebalanceo de inventario entre venues
    stats.ts       # z-score (arbitraje estadístico)
    config.ts      # exchanges, fees, withdrawal, latencia, riesgo, rebalanceo
    types.ts
scripts/test-engine.ts          # tests unitarios (pnpm test)
scripts/test-arb.ts             # test de humo con order books reales
```

Ver **[DEMO.md](DEMO.md)** para el guion de demo de 90s orientado al jurado.

## Cómo correr

```bash
cd web
pnpm install
pnpm dev            # http://localhost:3000
pnpm test           # tests unitarios del motor (13 casos)
```

## Qué demuestra (criterios del jurado)

- **Velocidad:** fetch paralelo de exchanges; latencia por exchange y del server visibles en la UI.
- **Precisión neta:** fees por exchange + slippage por order book; rechazo de net-negativos.
- **Robustez:** fills parciales, restricciones de wallet, exchanges offline tolerados, tope de riesgo.
- **Estrategia:** ranking de oportunidades y tamaño óptimo por profitabilidad marginal.
- **Arquitectura/código:** TypeScript tipado, lógica pura separada de la UI, testeable.
- **UI:** mercado en vivo, oportunidades, operaciones, P&L acumulado y balances en tiempo real.

## Limitaciones honestas

- Libro L2 completo por WS en 4 venues; **Coinbase** queda en REST + ticker WS (su canal level2 exige
  autenticación). El bucle de detección corre a ~1.2s; el HFT real opera en microsegundos.
- Pares BTC/USD (y BTC/ETH/USD para el triangular). El arbitraje "real" requiere inventario
  pre-posicionado entre venues — que es justo lo que simulamos, con rebalanceo automático.
- Fees, withdrawal, latencia y probabilidad de fill son aproximados y públicos por exchange; no incluye
  descuentos personalizados.
