import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { prisma } from "../src/db/prisma.js";
import { config } from "../src/config/env.js";

const inputPath = resolve(process.env.HISTORICAL_POSTS_FILE ?? "data/data-1789693588210.csv");
if (!existsSync(inputPath)) {
  console.error(`Historical export not found: ${inputPath}`);
  process.exitCode = 1;
} else {
  const rows = parseCsv(await readFile(inputPath, "utf8"));
  const report = { inserted: 0, updated: 0, invalid: 0, skipped: 0, checkpoint: null };
  for (const row of rows) {
    const externalId = String(row.externalId ?? row.external_id ?? row.id ?? "").trim();
    const publishedAt = new Date(row.publishedAt ?? row.published_at ?? row.createdAt ?? row.created_at ?? "");
    if (!externalId || Number.isNaN(publishedAt.getTime())) { report.invalid += 1; continue; }
    const existing = await prisma.sourcePost.findUnique({ where: { platform_externalId: { platform: "X", externalId } }, select: { id: true } });
    await prisma.sourcePost.upsert({ where: { platform_externalId: { platform: "X", externalId } }, update: { text: row.text ?? "", noteTweetText: row.noteTweetText ?? row.note_tweet_text ?? null, conversationId: row.conversationId ?? row.conversation_id ?? null, authorId: row.authorId ?? row.author_id ?? null, publishedAt, language: row.language ?? row.lang ?? null, publicMetrics: parseJson(row.publicMetrics ?? row.public_metrics), attachments: parseJson(row.attachments), rawPayload: parseJson(row.rawPayload ?? row.raw_payload) ?? row }, create: { id: row.id && /^[a-zA-Z0-9_-]+$/.test(row.id) ? row.id : randomUUID(), platform: "X", sourceAccount: row.sourceAccount ?? row.source_account ?? config.X_SOURCE_ACCOUNT_NAME, externalId, text: row.text ?? "", noteTweetText: row.noteTweetText ?? row.note_tweet_text ?? null, conversationId: row.conversationId ?? row.conversation_id ?? null, authorId: row.authorId ?? row.author_id ?? null, publishedAt, language: row.language ?? row.lang ?? null, publicMetrics: parseJson(row.publicMetrics ?? row.public_metrics), attachments: parseJson(row.attachments), rawPayload: parseJson(row.rawPayload ?? row.raw_payload) ?? row } });
    existing ? report.updated += 1 : report.inserted += 1;
    if (!report.checkpoint || publishedAt > new Date(report.checkpoint.publishedAt)) report.checkpoint = { externalId, publishedAt: publishedAt.toISOString() };
  }
  console.log(JSON.stringify(report, null, 2));
  await prisma.$disconnect();
}

function parseJson(value) { if (!value) return null; if (typeof value === "object") return value; try { return JSON.parse(value); } catch { return null; } }
function parseCsv(input) {
  const lines = input.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const parseLine = (line) => { const cells = []; let value = ""; let quoted = false; for (let i = 0; i < line.length; i += 1) { const char = line[i]; if (char === '"' && line[i + 1] === '"') { value += '"'; i += 1; } else if (char === '"') quoted = !quoted; else if (char === "," && !quoted) { cells.push(value); value = ""; } else value += char; } cells.push(value); return cells; };
  const headers = parseLine(lines[0]);
  return lines.slice(1).map((line) => Object.fromEntries(parseLine(line).map((value, index) => [headers[index], value])));
}
