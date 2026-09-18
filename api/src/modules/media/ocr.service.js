import { createWorker } from "tesseract.js";

export function normalizeOcrText(value) {
  return String(value ?? "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export async function runOcr(buffer, { language = "eng" } = {}) {
  const worker = await createWorker(language);
  try {
    const result = await worker.recognize(buffer);
    const text = result.data.text ?? "";
    return { text, normalizedText: normalizeOcrText(text), confidence: result.data.confidence ?? null, engine: "tesseract", engineVersion: null };
  } finally {
    await worker.terminate();
  }
}
