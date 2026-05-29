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
Exchanges (Coinbase, Kraken, Bitstamp, Gemini)
        │  REST order books (públicos)
        ▼
/api/orderbooks  ── server-side (evita CORS y bloqueos geo), fetch en paralelo
        │  OrderBook normalizado (bids desc, asks asc, latencia por exchange)
        ▼
Cliente (React, polling ~1.5s)
   ├─ detectOpportunities()  ── cross-exchange ask<bid, ranking por neto
   ├─ optimalArb()           ── tamaño óptimo por profitabilidad MARGINAL
   │                            (recorre el book nivel a nivel → slippage y
   │                             fills parciales nativos)
   ├─ simulateExecution()    ── respeta saldos de wallet, fills parciales
   └─ P&L acumulado + historial + balances (estado en el navegador)
```

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

Order books públicos de **Coinbase, Kraken, Bitstamp y Gemini** (BTC/USD, sin API key). Fees taker
aproximados y públicos por exchange (en `src/lib/arb/config.ts`), documentados como supuestos.

## Estructura

```
web/src/
  app/api/orderbooks/route.ts   # BFF: fetch paralelo de order books
  app/page.tsx                  # render del dashboard
  components/arb/ArbDashboard.tsx  # UI tiempo real (polling, KPIs, tablas, P&L)
  lib/arb/
    exchanges.ts   # conectores + normalización
    engine.ts      # detección, optimalArb, simulación (puro, testeable)
    config.ts      # exchanges, fees, parámetros
    types.ts
scripts/test-arb.ts             # test de humo con order books reales
```

## Cómo correr

```bash
cd web
pnpm install
pnpm dev            # http://localhost:3000
pnpm dlx tsx scripts/test-arb.ts   # test de humo del motor
```

## Qué demuestra (criterios del jurado)

- **Velocidad:** fetch paralelo de exchanges; latencia por exchange y del server visibles en la UI.
- **Precisión neta:** fees por exchange + slippage por order book; rechazo de net-negativos.
- **Robustez:** fills parciales, restricciones de wallet, exchanges offline tolerados, tope de riesgo.
- **Estrategia:** ranking de oportunidades y tamaño óptimo por profitabilidad marginal.
- **Arquitectura/código:** TypeScript tipado, lógica pura separada de la UI, testeable.
- **UI:** mercado en vivo, oportunidades, operaciones, P&L acumulado y balances en tiempo real.

## Limitaciones honestas

- Polling (~1.5s), no WebSocket de baja latencia (HFT real opera en microsegundos). Suficiente para la
  demo; la arquitectura admite cambiar a WebSocket.
- Pares BTC/USD para comparabilidad; no se modela el tiempo real de retiro on-chain entre exchanges
  (el arbitraje "real" requiere inventario pre-posicionado, que es justo lo que simulamos).
- Fees taker aproximados por tier; no incluye descuentos personalizados.
