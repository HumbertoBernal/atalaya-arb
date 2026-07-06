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

## Tecnologías utilizadas

| Capa | Tecnología |
|------|-----------|
| Framework full-stack | **Next.js 16** (App Router) |
| Lenguaje | **TypeScript** (tipado end-to-end) |
| UI | **React 19**, **Tailwind CSS v4**, **Recharts** (gráficas) |
| Backend / API | **Next.js Route Handlers** (BFF server-side; sin backend con estado) |
| Motor cuant | **TypeScript puro** (funciones puras y testeables en `lib/arb/`) |
| Tiempo real | **WebSocket** (order book L2 + top-of-book) + **REST** (fallback) |
| Datos de mercado | APIs públicas de **Coinbase, Kraken, Bitstamp, Gemini, Bitfinex** (sin API keys) |
| Testing | **tsx** + runner propio (`pnpm test`, 87 aserciones deterministas) |
| Tooling | **pnpm**, **ESLint**, **MathJax** (render de fórmulas) |
| Deploy | **Vercel** (producción) · **GitHub** (repo) |

> Decisión deliberada: **sin base de datos ni backend con estado**. El simulador corre en el cliente y solo
> el fetch de datos va server-side — la demo funciona en vivo sin credenciales ni infraestructura frágil.

## Cómo funciona

```
Exchanges (Coinbase, Kraken, Bitstamp, Gemini, Bitfinex)
   │  WebSocket L2 (KR/BS/BF/GM) + ticker (CB/KR/BS/BF)   │  REST (fallback)
   ▼                                                      ▼
L2Feed + LiveFeed (cliente)                 /api/orderbooks · /api/triangular
   │  libro completo + mejor bid/ask                 │  server-side (evita CORS/geo)
   └───────────► merge (L2 válido > WS top > REST) ◄─┘
        ▼            ▼ applyChaos() — escenarios adversos inyectables (demo)
Cliente (React, ~1.2s + push WS) — todo recibe EngineParams (44 tunables runtime)
   ├─ detectOpportunities()  ── cross-exchange ask<bid, umbral en bps, ranking por neto
   ├─ optimalArb()           ── tamaño óptimo por profitabilidad MARGINAL
   │                            (recorre el book → slippage y fills parciales)
   ├─ frictionCosts()        ── adverse selection por latencia + retiro amortizado
   ├─ evaluateRisk()         ── circuit breaker (stale / anómalo / drawdown / abortos)
   ├─ FASE 1: orden pendiente ─ lo viable se ejecuta hasta el próximo tick
   ├─ FASE 2: recheckOpportunity() ─ re-verifica contra el libro FRESCO;
   │                            deriva > tolerancia → orden ABORTADA (visible)
   ├─ simulateExecution()    ── respeta saldos de wallet, fills parciales
   ├─ planRebalance()        ── transferencias dirigidas venue→venue con
   │                            fee de red y confirmación on-chain simulada
   ├─ detectTriangular()     ── ciclos intra-exchange USD/BTC/ETH
   └─ P&L + ledger + balances (persistidos y restaurados vía localStorage)
```

### Capacidades

- **44 parámetros ajustables en runtime** desde la UI (panel "Parámetros del motor"): umbral mínimo
  de rentabilidad en bps, tamaño máximo por orden, exchanges activos (on/off por venue), fees
  taker/maker editables por exchange, latencia y withdrawal por venue, volatilidad para adverse
  selection, tolerancia de deriva pre-ejecución, riesgo (drawdown, staleness, abortos), rebalanceo
  (mínimos, fee de red, delay de confirmación) y capital inicial. Con **presets**
  (Conservador / Balanceado / Agresivo) y persistencia en localStorage.
- **5 venues USD principales**: Coinbase, Kraken, Bitstamp, Gemini, Bitfinex.
- **Order book L2 completo por WebSocket** (Bitstamp, Kraken, Bitfinex, Gemini): se mantiene el libro
  entero en tiempo real (snapshot + deltas), con reconexión (backoff exponencial + jitter), guarda de
  libro-cruzado y **fallback a REST** si un feed cae. Coinbase por REST + ticker WS (su L2 exige auth).
- **Ejecución en dos fases con re-verificación**: lo viable se convierte en orden pendiente y se
  re-verifica contra el **libro fresco** del siguiente tick; si el neto derrapó más que la tolerancia
  o el spread se cerró, la orden se **aborta** — visible en el ledger con motivo y deriva en bps.
- **Modo caos**: inyector de escenarios adversos (venue caído, shock de precio ±200 bps, sequía de
  liquidez, feeds congelados) para **demostrar** los breakers y fallbacks en vivo, no solo afirmarlos.
- **Modo Maker / Taker**: ejecución inmediata (taker) o por órdenes límite (maker, fees menores, viable
  en retail) con haircut por probabilidad de fill configurable (riesgo de ejecución).
- **Cálculo neto completo**: fees por exchange + slippage (order book real) + **adverse selection
  por latencia de red** + **withdrawal fee amortizado** (rebalanceo).
- **Circuit breaker con semántica de mesa real**: detiene la ejecución ante datos stale, spread
  anómalo (dato corrupto), drawdown o **N ejecuciones abortadas seguidas**. Los trips *operativos*
  (stale/anómalo/abortos) se **re-arman solos** tras un cooldown configurable; el trip por
  **drawdown es duro** — un límite de pérdida exige re-armado manual, no se renueva solo. Los
  auto-rearms quedan contados en la analítica (transparencia).
- **Laboratorio de experimentos**: hasta 4 configuraciones (presets + la tuya) corren **en paralelo
  sobre el mismo mercado en vivo**, cada una con wallets, breaker y rebalanceos independientes —
  tabla comparativa y P&L superpuesto para ver los trade-offs con evidencia, no con opiniones.
- **Sweep reproducible por CLI**: `pnpm tape 15` graba una cinta del mercado real (JSONL) y
  `pnpm experiment <cinta> --grid` replaya una grilla de configuraciones contra **exactamente los
  mismos ticks** — comparación determinista que justifica los defaults del motor.
- **Rebalanceo dirigido de inventario**: cuando un venue cae bajo el mínimo, el más sobrado le
  transfiere; el BTC paga fee de red y **tarda en confirmar** — mientras viaja no está disponible
  (visible como "en tránsito" en la UI).
- **Profundidad del libro** (depth chart acumulado por venue): la materia prima del slippage, visible.
- **Arbitraje triangular** intra-exchange (Coinbase USD/BTC/ETH), ambas direcciones del ciclo.
- **Matriz de spreads** (heatmap exchange × exchange) con el neto en bps de cada combinación.
- **Arbitraje estadístico**: z-score del mayor spread vs su media móvil (señal de mean-reversion).
- **Panel de métricas**: latencia de detección p50/p99, throughput WS (msgs/seg), frescura de datos.
- **Sesión persistente**: P&L, ledger, wallets y transferencias sobreviven recargas (localStorage);
  el ledger se exporta a **CSV**.
- **Tests**: `pnpm test` (87 aserciones del motor y el simulador, deterministas).

### Decisiones técnicas clave

- **Parámetros por inyección, no por constantes.** El motor son funciones puras que reciben
  `EngineParams` (`lib/arb/params.ts`); las constantes de `config.ts` son solo los *defaults*. La UI
  reconfigura el motor en runtime sin recargar, y los tests inyectan escenarios sin mocks.
- **Ejecución en dos fases.** Detectar y ejecutar sobre el mismo snapshot es hacer trampa: en la
  realidad el mercado se mueve durante la ejecución. Cada orden se re-verifica contra el libro del
  siguiente tick (`recheckOpportunity`) y se aborta si el neto derrapó — el costo de la ventana de
  ejecución se **simula**, no solo se estima.
- **Simulador en el cliente + fetch server-side.** El navegador mantiene el estado (wallets, P&L,
  historial) y hace polling a un Route Handler que trae los order books. Así la demo **funciona en vivo
  para el jurado sin depender de un backend con estado** ni de credenciales, y evita CORS/bloqueos geo.
- **Tamaño óptimo por profitabilidad marginal.** En vez de ejecutar un volumen fijo, `optimalArb`
  recorre asks y bids nivel por nivel y ejecuta **mientras el ingreso marginal de venta (neto de fee)
  supere al costo marginal de compra**. Esto incorpora slippage y órdenes parciales de forma nativa y
  maximiza la ganancia neta sin operar volumen no rentable.
- **Net-first.** Toda oportunidad se evalúa neta de fees (por exchange) y slippage real. Las que
  son positivas en bruto pero negativas en neto — o bajo el umbral configurado — **no se ejecutan**.
- **Tier de fees configurable.** Retail / Pro / VIP / Maker (multiplican los fees base editables por
  venue). Con fees retail el arbitraje BTC/USD casi nunca es neto-positivo (mercados eficientes); a
  fees HFT aparecen ejecuciones — exactamente por qué el arbitraje real es un juego de baja latencia.
- **Gestión de riesgo.** Tope de notional por operación, fills parciales por liquidez y por saldo de
  wallet, rechazo de no rentables, y circuit breaker de 4 condiciones con cooldown auto-rearm.
- **Rebalanceo con física real.** Transferir BTC entre exchanges no es gratis ni instantáneo: las
  transferencias dirigidas pagan fee de red y confirman con delay; el capital en tránsito no opera.
- **Un solo simulador, tres consumidores.** Toda la lógica del tick vive en `lib/arb/simulator.ts`
  (función pura `stepSession`): la usan el dashboard, el laboratorio de configs en paralelo y el
  sweep por CLI. Cero duplicación — lo que ves en la demo es exactamente lo que corren los tests
  y los experimentos.

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
    ArbDashboard.tsx  # UI tiempo real (KPIs, tablas, P&L, ledger, balances)
    ConfigPanel.tsx   # panel de parametrización (44 tunables en runtime)
    ChaosPanel.tsx    # inyector de escenarios adversos (demo de robustez)
    LabPanel.tsx      # laboratorio: configs en paralelo sobre el mismo mercado
    DepthChart.tsx    # profundidad acumulada del libro por venue
    SpreadMatrix.tsx  # heatmap exchange × exchange
    useArbEngine.ts   # orquestador: feeds, ticks del simulador, persistencia
  lib/arb/
    exchanges.ts   # conectores REST + normalización
    livefeed.ts    # feeds WebSocket top-of-book (cliente) + reconexión
    l2book.ts      # order book L2 completo por WebSocket (snapshot + deltas)
    engine.ts      # detección, optimalArb, fricción, re-check, ejecución (puro)
    simulator.ts   # stepSession: el tick completo como función pura (núcleo común)
    params.ts      # EngineParams: tunables runtime + presets + merge persistido
    chaos.ts       # escenarios adversos inyectables (capa de simulación)
    risk.ts        # circuit breaker (4 condiciones + cooldown)
    triangular.ts  # arbitraje triangular intra-exchange
    rebalance.ts   # rebalanceo dirigido + transferencias con delay on-chain
    stats.ts       # z-score (arbitraje estadístico)
    config.ts      # defaults: exchanges, fees, withdrawal, latencia, riesgo
    types.ts
scripts/test-engine.ts          # tests unitarios (pnpm test, 87 aserciones)
scripts/test-arb.ts             # test de humo con order books reales
scripts/record-tape.ts          # graba una cinta del mercado real (pnpm tape)
scripts/experiment.ts           # sweep de configs sobre la cinta (pnpm experiment)
```

Ver **[DEMO.md](DEMO.md)** para el guion de demo de ~2 min orientado al jurado.

## Instalación y ejecución

**Prerequisitos:** Node.js 18+ y [pnpm](https://pnpm.io/installation).

```bash
git clone https://github.com/HumbertoBernal/atalaya-arb.git
cd atalaya-arb/web

pnpm install        # instala dependencias

pnpm dev            # desarrollo → http://localhost:3000
pnpm test           # tests unitarios del motor (87 aserciones)
pnpm build          # build de producción
pnpm start          # sirve el build de producción

# Experimentos reproducibles (¿qué configuración funciona mejor?)
pnpm tape 15                              # graba 15 min de mercado real → JSONL
pnpm experiment data/tapes/<cinta>.jsonl --grid   # sweep de configs sobre esa cinta
```

No requiere variables de entorno ni API keys: todos los datos son de endpoints públicos.

## Qué demuestra (criterios de la fase final)

- **Profundidad y parametrización:** 44 variables controlables en runtime — umbrales, fees, tamaños
  de orden, exchanges activos, riesgo, rebalanceo, capital — con presets y persistencia. Y dos formas
  de **comparar configuraciones con evidencia**: el laboratorio en vivo (configs en paralelo sobre el
  mismo mercado) y el sweep reproducible por CLI sobre cintas grabadas.
- **Robustez ante escenarios adversos:** órdenes que fallan (abortos por deriva, visibles y con
  motivo), liquidez insuficiente (fills parciales por libro y por saldo), mercado moviéndose durante
  la ejecución (re-verificación en dos fases), venue caído (fallback WS→REST), datos corruptos o
  stale (circuit breaker) — y un **modo caos** para provocarlo todo en vivo.
- **Gestión de wallets y rebalanceo:** balances por venue con restricciones reales, transferencias
  dirigidas automáticas con fee de red y delay de confirmación (capital en tránsito visible).
- **Interfaz y visualización:** P&L en vivo, ledger con fills/parciales/abortos, oportunidades con
  desglose de costos, profundidad del libro, matriz de spreads, balances y transferencias en tiempo
  real; sesión persistente y export CSV.
- **Documentación y claridad:** este README, [DEMO.md](DEMO.md), la página
  [Cómo funciona](https://atalaya-arb.vercel.app/como-funciona.html) con la matemática completa, y un
  motor de funciones puras con 87 aserciones de test.

## Limitaciones honestas

- Libro L2 completo por WS en 4 venues; **Coinbase** queda en REST + ticker WS (su canal level2 exige
  autenticación). El bucle de detección corre a ~1.2s; el HFT real opera en microsegundos.
- La **ventana de ejecución** de las dos fases es un tick (~1.2s) — más larga que la latencia real de
  una orden (~100-300 ms). Es un proxy conservador: si sobrevive esa deriva, sobrevive la real.
- El **delay de confirmación** de transferencias (default 45 s) está escalado para demo; en mainnet
  una confirmación de BTC toma ~10 min. El mecanismo (capital en tránsito no disponible) es el mismo.
- Pares BTC/USD (y BTC/ETH/USD para el triangular). El arbitraje "real" requiere inventario
  pre-posicionado entre venues — que es justo lo que simulamos, con rebalanceo automático.
- Fees, withdrawal, latencia y probabilidad de fill son aproximados y públicos por exchange (todos
  editables en el panel de parámetros); no incluye descuentos personalizados.
- **Sesgo conservador deliberado**: los costos de latencia y retiro se descuentan *ex-ante* en cada
  trade **y además** el sistema paga los costos *realizados* (fee de red en cada rebalanceo, deriva
  real de precios vía la re-verificación). Doble colchón a propósito: preferimos subestimar el P&L.
