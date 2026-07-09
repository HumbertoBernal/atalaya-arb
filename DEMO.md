# Guion de demo — Atalaya (Bot de Arbitraje de BTC)

**URL:** https://atalaya-arb.vercel.app · **Repo:** https://github.com/HumbertoBernal/atalaya-arb

Demo de ~2 minutos, pensada para un jurado técnico. Cada paso indica **qué decir** y
**a qué criterio de la fase final** responde.

---

## 0 · Apertura (10s)
> "Atalaya es un bot que detecta arbitraje de Bitcoin en tiempo real entre 5 exchanges y
> simula su ejecución **neta de todos los costos reales**. La clave no es ver la oportunidad,
> sino decidir correctamente si conviene ejecutarla — y sobrevivir cuando el mercado se mueve
> en contra."

Abre la URL. Señala que ya está corriendo en vivo (no es un video). Si aparece el badge
"Sesión restaurada", menciónalo: el estado sobrevive recargas.

## 1 · Parametrización — 46 variables en runtime (25s) · *criterio: profundidad y parametrización*
- Abre el panel **"Parámetros del motor"**. Recorre los grupos: estrategia, exchanges activos,
  fees por venue, riesgo, rebalanceo, capital.
  > "Todo el motor recibe estos parámetros por inyección — 46 variables ajustables sin recargar."
- Sube el **umbral mínimo a 5 bps** → en la tabla de oportunidades aparecen filas "bajo umbral":
  netas positivas que el bot ahora rechaza por política.
- Apaga un exchange (p. ej. Bitfinex) → desaparece del universo de detección al instante.
- Muestra los **presets** (Conservador / Balanceado / Agresivo).

## 2 · Precisión neta — el corazón honesto (20s) · *criterio: profundidad*
- En "Oportunidades cross-exchange", muestra una fila con **spread bruto positivo** pero
  **estado 'no neto'**.
  > "Aquí hay $15 de spread bruto, pero tras fees, slippage, latencia y retiro, el neto es
  > negativo. El bot **no la ejecuta**. Un bot que sí lo haría, perdería dinero."
- Cambia el **Tier de fees** de Retail → VIP: el mismo mercado se vuelve capturable.
  > "Por eso el arbitraje real es un juego de bajísima latencia y fees de HFT."
- Señala una fila "⏳ ejecutando": **ejecución en dos fases** — la orden se re-verifica contra
  el libro fresco antes de llenarse; si el neto derrapó, se aborta (se ve en el ledger con Δbps).

## 3 · Modo caos — robustez demostrada, no afirmada (25s) · *criterio: robustez*
- Abre **"Escenarios adversos"**.
- **Tira un venue** (p. ej. Kraken) → pasa a offline, el bot sigue operando con el resto.
- **Congela los feeds** → en ~6s el **circuit breaker** dispara por datos stale. Señala el
  contador de **auto re-arm**: el bot se recupera solo tras el cooldown (o con "Re-armar ya").
- **Sequía de liquidez** → los fills se vuelven parciales o desaparecen.
  > "No les cuento que es robusto: se los rompo en vivo y ven cómo reacciona — y cómo se recupera."

## 4 · Laboratorio — ¿qué config funciona? Evidencia, no opinión (20s) · *criterio: parametrización*
- Abre **"Laboratorio"**, selecciona Conservador + Balanceado + Agresivo y **▶ Iniciar**.
- A los pocos ticks: tabla comparativa (P&L, fills, abortos, breaker por config) y P&L superpuesto.
  > "Tres estrategias corriendo en paralelo sobre exactamente el mismo mercado, cada una con su
  > propia economía. Y para rigor reproducible: `pnpm tape` graba el mercado real y
  > `pnpm experiment` barre una grilla de configs contra la misma cinta."
- Si el modo caos sigue activo, mejor aún: se ve qué config sobrevive el estrés.

## 5 · Wallets y rebalanceo (15s) · *criterio: gestión de wallets*
- **Balances de wallets**: el inventario se mueve con cada trade.
- Si aparece el recuadro **"En tránsito"**: transferencias dirigidas venue→venue con fee de red
  y confirmación on-chain simulada.
  > "Rebalancear no es gratis ni instantáneo: el BTC en tránsito no está disponible para operar."

## 6 · Estrategia y visualización (15s) · *criterio: UI/visualización*
- **Profundidad del libro**: la materia prima del slippage, por venue.
- **Matriz de spreads** (25 combinaciones), **triangular** (USD→BTC→ETH→USD) y **estadístico**
  (z-score / mean-reversion). "Tres estrategias, no una."
- **Export CSV** del ledger para auditar las operaciones.

## 7 · Cierre — código y honestidad (5s) · *criterio: documentación y claridad*
> "Todo es TypeScript tipado, con un solo simulador puro que comparten el dashboard, el laboratorio
> y los experimentos por CLI — `pnpm test`, 94 aserciones. Y lo más importante: es **honesto**.
> No promete alpha que no existe; demuestra exactamente dónde y por qué el arbitraje funciona,
> y qué lo mata."

---

## Preguntas que el jurado podría hacer (y respuestas)

- **"¿Por qué no veo profit a fees retail?"** → Correcto: BTC/USD entre majors es eficiente; el
  spread no cubre los costos. El bot lo detecta y no opera. Esa es la respuesta honesta y el
  diferenciador. A escala HFT (tier VIP/Maker) sí es rentable.
- **"¿Es WebSocket real?"** → Sí. Libro L2 completo (snapshot + deltas) por WS en Kraken,
  Bitstamp, Bitfinex y Gemini; Coinbase por ticker WS + REST (su canal L2 exige autenticación).
  Con reconexión por backoff exponencial y fallback a REST. Latencias medidas en el panel.
- **"¿Cómo modelan slippage?"** → Recorriendo el order book real nivel por nivel; el tamaño
  óptimo se calcula por profitabilidad marginal.
- **"¿Y si el precio se mueve mientras ejecutas?"** → Dos fases: la orden se re-verifica contra
  el libro fresco del siguiente tick; si la deriva supera la tolerancia (configurable), se
  aborta. Además el costo esperado de adverse selection por latencia se descuenta siempre.
- **"¿Y los costos de retiro / latencia?"** → Modelados: adverse selection por latencia de red
  (1σ) + withdrawal fee amortizado + fee de red y delay en cada rebalanceo.
- **"¿Cuál es la mejor configuración?"** → Medido con 5 h de mercado real (tablas en el README):
  el preset "Óptimo" (umbral 4 bps + sizing 50%) ganó con +$418; la agresiva (mismo sizing SIN
  umbral) perdió $1,078. El hallazgo fino: **umbral y sizing interactúan** — primero filtrar
  calidad, después meterle tamaño. El costo realizado de rebalanceo domina al micro-edge; por
  eso existen el sizing por inventario y la cadencia mínima, y el P&L va descompuesto en la UI.
- **"¿Qué pasa si un exchange se cae?"** → Pruébalo en vivo con el modo caos: fallback a REST,
  y si todo queda stale, el circuit breaker detiene la ejecución.

## Checklist pre-demo
- [ ] Abrir la URL 1 min antes (los feeds WS tardan ~2s en conectar).
- [ ] Reset si quieres empezar de cero (la sesión persiste entre recargas).
- [ ] Dejar el tier en el default elegido (Retail para la historia honesta / VIP para ver acción).
- [ ] Tener el repo abierto en otra pestaña para mostrar `lib/arb/engine.ts` y `pnpm test`.
- [ ] Ensayar el acto de caos: congelar feeds → breaker → re-armar (es el momento wow).
