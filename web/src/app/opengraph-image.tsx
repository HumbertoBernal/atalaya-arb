// Imagen Open Graph generada en el server (next/og · Satori): el preview del
// link al compartir la URL — primera impresión ante el comité.
import { ImageResponse } from "next/og";

export const alt = "Atalaya · Bot de arbitraje de BTC en tiempo real";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "linear-gradient(135deg, #0a0a0b 0%, #101820 100%)",
          padding: 72,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 16,
              height: 16,
              borderRadius: 999,
              background: "#34d399",
              boxShadow: "0 0 24px #34d399",
            }}
          />
          <div style={{ color: "#9a9aa6", fontSize: 30, letterSpacing: 6 }}>EN VIVO · 5 EXCHANGES · WEBSOCKET L2</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 24 }}>
            <div style={{ color: "#ffffff", fontSize: 110, fontWeight: 700 }}>Atalaya</div>
            <div style={{ color: "#22d3ee", fontSize: 54, fontWeight: 600 }}>· Arbitraje BTC</div>
          </div>
          <div style={{ color: "#d6d6dd", fontSize: 34, lineHeight: 1.4, maxWidth: 1000 }}>
            Detección en tiempo real, ejecución simulada en dos fases neta de fees, slippage y latencia —
            con 44 parámetros en runtime, modo caos y laboratorio de estrategias.
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 14 }}>
            {["Coinbase", "Kraken", "Bitstamp", "Gemini", "Bitfinex"].map((v) => (
              <div
                key={v}
                style={{
                  color: "#9a9aa6",
                  fontSize: 24,
                  border: "1px solid #26262e",
                  borderRadius: 999,
                  padding: "8px 22px",
                  background: "#15151a",
                }}
              >
                {v}
              </div>
            ))}
          </div>
          <div style={{ color: "#22d3ee", fontSize: 26 }}>atalaya-arb.vercel.app</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
