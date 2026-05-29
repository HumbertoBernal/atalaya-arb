import { NextResponse } from "next/server";
import { fetchAllBooks } from "@/lib/arb/exchanges";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Devuelve los order books normalizados de todos los exchanges (server-side).
export async function GET() {
  const start = Date.now();
  const books = await fetchAllBooks();
  return NextResponse.json(
    {
      ts: Date.now(),
      serverLatencyMs: Date.now() - start,
      books,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
