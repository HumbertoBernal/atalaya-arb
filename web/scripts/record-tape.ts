// Graba una "cinta" del mercado real: order books de los 5 exchanges cada
// ~1.2s, en JSONL (una línea = un tick). La cinta alimenta scripts/experiment.ts
// para barrer configuraciones contra EXACTAMENTE los mismos datos — la única
// forma justa y reproducible de comparar estrategias.
//
// Uso: pnpm tape [minutos] [archivo-salida]
//      pnpm tape 15
//      pnpm tape 30 data/tapes/mi-cinta.jsonl
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fetchAllBooks } from "../src/lib/arb/exchanges";
import { POLL_MS } from "../src/lib/arb/config";

const minutes = Number(process.argv[2] ?? 10);
const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
const outPath = process.argv[3] ?? `data/tapes/tape-${stamp}.jsonl`;

async function main() {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.error("Uso: pnpm tape [minutos>0] [archivo-salida]");
    process.exit(1);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  const stream = createWriteStream(outPath, { flags: "w" });
  const totalTicks = Math.ceil((minutes * 60_000) / POLL_MS);
  console.log(`Grabando ${minutes} min (~${totalTicks} ticks cada ${POLL_MS}ms) → ${outPath}`);

  let written = 0;
  let failures = 0;

  // Ctrl-C: cerrar el stream limpiamente — lo grabado hasta aquí sigue siendo
  // una cinta válida (interrumpir una grabación larga es el caso común).
  process.on("SIGINT", () => {
    stream.end();
    console.log(`\nInterrumpido: ${written} ticks grabados (${failures} fallidos) en ${outPath}`);
    console.log(`La cinta parcial es usable: pnpm experiment ${outPath}`);
    process.exit(0);
  });

  for (let i = 0; i < totalTicks; i++) {
    const t0 = Date.now();
    try {
      const books = await fetchAllBooks();
      const okCount = books.filter((b) => b.ok).length;
      if (okCount >= 2) {
        stream.write(JSON.stringify({ ts: Date.now(), books }) + "\n");
        written++;
      } else {
        failures++;
      }
      if (i % 25 === 0) {
        const pct = ((i / totalTicks) * 100).toFixed(0);
        console.log(`  ${pct}% · tick ${i}/${totalTicks} · ${okCount}/5 venues ok`);
      }
    } catch {
      failures++; // tick perdido; la cinta sigue
    }
    const elapsed = Date.now() - t0;
    if (elapsed < POLL_MS) await new Promise((r) => setTimeout(r, POLL_MS - elapsed));
  }

  stream.end();
  console.log(`\nListo: ${written} ticks grabados (${failures} fallidos) en ${outPath}`);
  console.log(`Siguiente paso: pnpm experiment ${outPath}`);
}

main().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
