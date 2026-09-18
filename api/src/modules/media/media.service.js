import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preprocessImage } from "./image-preprocessor.service.js";
import { runOcr } from "./ocr.service.js";

export function createMediaService({ prisma, maxBytes, timeoutMs, language, fetchImpl = fetch, ocrRunner = runOcr }) {
  return {
    async processMedia(media) {
      const tempDir = join(tmpdir(), `gridwatch-${randomUUID()}`);
      await mkdir(tempDir, { recursive: true });
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const mediaUrl = new URL(media.url);
        if (!["pbs.twimg.com", "video.twimg.com", "abs.twimg.com", "twitter.com", "x.com"].includes(mediaUrl.hostname)) throw new Error("Media URL host is not trusted");
        const response = await fetchImpl(media.url, { signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) throw new Error(`Media download returned ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > maxBytes) throw new Error("Media exceeds configured size limit");
        const variants = await preprocessImage(buffer);
        const results = [];
        for (const variant of variants) {
          const ocr = await ocrRunner(variant.buffer, { language });
          const engineVersion = ocr.engineVersion ?? "unknown";
          const saved = await prisma.ocrResult.upsert({ where: { mediaId_engine_engineVersion_preprocessVariant: { mediaId: media.id, engine: ocr.engine, engineVersion, preprocessVariant: variant.variant } }, update: { text: ocr.text, normalizedText: ocr.normalizedText, confidence: ocr.confidence, status: "SUCCEEDED", processedAt: new Date() }, create: { mediaId: media.id, engine: ocr.engine, engineVersion, preprocessVariant: variant.variant, text: ocr.text, normalizedText: ocr.normalizedText, confidence: ocr.confidence, status: "SUCCEEDED" } });
          results.push(saved);
        }
        return results;
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
