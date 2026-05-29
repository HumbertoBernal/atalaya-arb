// Capa de mejora LLM del reporte ejecutivo.
// - Sin API keys: devuelve el reporte determinista del engine intacto.
// - Con ANTHROPIC_API_KEY u OPENAI_API_KEY: reescribe el reporte para mayor
//   claridad ejecutiva, manteniendo la honestidad (no inflar capacidad predictiva).
// Diseñado para no romper nunca el flujo: si el LLM falla, cae al determinista.
import "server-only";

const SYSTEM = `Eres un analista cuantitativo que explica resultados complejos con precisión y lenguaje claro.
Reglas: no exageres la capacidad predictiva; si hay debilidades, destácalas; tono de demo ejecutiva, no de paper.
Mantén EXACTAMENTE las mismas secciones Markdown (##) del reporte original. Responde solo el Markdown.`;

export type LlmStatus = "deterministic" | "anthropic" | "openai";

export async function enhanceReport(
  deterministic: string,
): Promise<{ text: string; status: LlmStatus }> {
  const prompt = `Mejora la redacción de este reporte sin cambiar los hechos ni las cifras:\n\n${deterministic}`;

  try {
    if (process.env.ANTHROPIC_API_KEY) {
      const { anthropic } = await import("@ai-sdk/anthropic");
      const { generateText } = await import("ai");
      const { text } = await generateText({
        model: anthropic("claude-opus-4-8"),
        system: SYSTEM,
        prompt,
      });
      return { text, status: "anthropic" };
    }
    if (process.env.OPENAI_API_KEY) {
      const { openai } = await import("@ai-sdk/openai");
      const { generateText } = await import("ai");
      const { text } = await generateText({
        model: openai("gpt-4o"),
        system: SYSTEM,
        prompt,
      });
      return { text, status: "openai" };
    }
  } catch {
    // cae al determinista
  }
  return { text: deterministic, status: "deterministic" };
}
