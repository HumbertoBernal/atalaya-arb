# Guion de demo — Atalaya (Bot de Arbitraje de BTC)

**URL:** https://atalaya-arb.vercel.app · **Repo:** https://github.com/HumbertoBernal/atalaya-arb

Demo de ~90 segundos, pensada para un jurado técnico. Cada paso indica **qué decir** y
**a qué criterio** responde.

---

## 0 · Apertura (10s)
> "Atalaya es un bot que detecta arbitraje de Bitcoin en tiempo real entre 5 exchanges y
> simula su ejecución **neta de todos los costos reales**. La clave no es ver la oportunidad,
> sino decidir correctamente si conviene ejecutarla."

Abre la URL. Señala que ya está corriendo en vivo (no es un video).

## 1 · Velocidad — feeds y métricas (15s) · *criterio #1*
- Señala los **puntos verdes** en "Mercado en vivo": feeds **WebSocket** (Coinbase, Kraken,
  Bitstamp, Bitfinex) empujando best bid/ask en vivo; Gemini por REST.
- Apunta al panel de métricas: **Detección p50/p99** (sub-ms), **WS msgs/seg**, **frescura**.
  > "No solo es rápido — lo **medimos** y lo mostramos."

## 2 · Precisión neta — el corazón honesto (20s) · *criterio #2*
- En "Oportunidades cross-exchange", muestra una fila con **spread bruto positivo** pero
  **estado 'no neto'**.
  > "Aquí hay $15 de spread bruto, pero tras fees, slippage, latencia y retiro, el neto es
  > negativo. El bot **no la ejecuta**. Un bot que sí lo haría, perdería dinero."
- Muestra el desglose de columnas: Fees, Latencia, Neto.

## 3 · El cambio de tier — por qué es un juego de HFT (15s) · *criterio #2/#4*
- Cambia el **Tier de fees** de Retail → VIP → Maker.
  > "El **mismo** mercado real: a fees retail no hay nada rentable (mercados eficientes); a
  > fees de HFT, los micro-spreads se vuelven capturables. Por eso el arbitraje real es un
  > juego de bajísima latencia y alto volumen."
- Al bajar el tier, aparecen ejecuciones y el **P&L** empieza a subir.

## 4 · Estrategia — más allá de cross-exchange (15s) · *criterio #4*
- **Matriz de spreads**: heatmap de las 25 combinaciones de venues a la vez.
- **Arbitraje triangular**: ciclos USD→BTC→ETH→USD intra-Coinbase.
- **Arbitraje estadístico**: z-score del spread; señal de mean-reversion cuando es inusual.
  > "Tres estrategias, no una."

## 5 · Robustez — riesgo y balances (10s) · *criterio #3*
- **Circuit breaker**: explica que se detiene ante datos stale, spread anómalo o drawdown.
- **Balances de wallets**: muestra cómo el inventario se mueve y, si aplica, el **rebalanceo**
  automático (con su costo real de red).
  > "Respeta la liquidez y el inventario reales — con fills parciales, no liquidez infinita."

## 6 · Cierre — código y honestidad (5s) · *criterio #5*
> "Todo es TypeScript tipado, con la lógica del motor pura y testeable — `pnpm test`, 13 casos.
> Y lo más importante: es **honesto**. No promete alpha que no existe; demuestra exactamente
> dónde y por qué el arbitraje funciona."

---

## Preguntas que el jurado podría hacer (y respuestas)

- **"¿Por qué no veo profit a fees retail?"** → Correcto: BTC/USD entre majors es eficiente; el
  spread no cubre los costos. El bot lo detecta y no opera. Esa es la respuesta honesta y el
  diferenciador. A escala HFT (tier VIP/Maker) sí es rentable.
- **"¿Es WebSocket real?"** → Sí, para 4 venues (top-of-book). La profundidad para sizing viene
  por REST. Gemini por REST por robustez. Latencias medidas en el panel.
- **"¿Cómo modelan slippage?"** → Recorriendo el order book real nivel por nivel; el tamaño
  óptimo se calcula por profitabilidad marginal.
- **"¿Y los costos de retiro / latencia?"** → Modelados: adverse selection por latencia de red
  (1σ) + withdrawal fee amortizado por rebalanceo.

## Checklist pre-demo
- [ ] Abrir la URL 1 min antes (los feeds WS tardan ~2s en conectar).
- [ ] Dejar el tier en el default elegido (Retail para la historia honesta / VIP para ver acción).
- [ ] Tener el repo abierto en otra pestaña para mostrar `lib/arb/engine.ts` y `pnpm test`.
