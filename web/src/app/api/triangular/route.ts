import { NextResponse } from "next/server";
import type { TriBooks, TriQuote } from "@/lib/arb/triangular";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const UA = "Atalaya-Arb/1.0";

async function ticker(product: string): Promise<TriQuote | null> {
  try {
    const res = await fetch(`https://api.exchange.coinbase.com/products/${product}/ticker`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { bid?: string; ask?: string };
    if (!d.bid || !d.ask) return null;
    return { bid: Number(d.bid), ask: Number(d.ask) };
  } catch {
    return null;
  }
}

// Top-of-book de BTC-USD, ETH-USD, ETH-BTC en Coinbase (para arbitraje triangular).
export async function GET() {
  const start = Date.now();
  const [btcUsd, ethUsd, ethBtc] = await Promise.all([
    ticker("BTC-USD"),
    ticker("ETH-USD"),
    ticker("ETH-BTC"),
  ]);

  if (!btcUsd || !ethUsd || !ethBtc) {
    return NextResponse.json({ ok: false, error: "feed incompleto" }, { status: 200 });
  }

  const books: TriBooks = { btcUsd, ethUsd, ethBtc };
  return NextResponse.json(
    { ok: true, ts: Date.now(), serverLatencyMs: Date.now() - start, exchange: "coinbase", books },
    { headers: { "Cache-Control": "no-store" } },
  );
}
