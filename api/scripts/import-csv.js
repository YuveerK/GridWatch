// Import an exported SourcePost CSV, keeping only posts strictly older than --before (default: oldest post in DB).
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { prisma } from '../src/db/prisma.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const dir = new URL('../data/', import.meta.url);
const file = arg('file') ?? readdirSync(dir).find((f) => f.startsWith('data-') && f.endsWith('.csv'));
const rows = parse(readFileSync(new URL(file, dir), 'utf8'), { columns: true, relax_quotes: true });

const oldest = (await prisma.sourcePost.aggregate({ _min: { publishedAt: true } }))._min.publishedAt;
const before = arg('before') ? new Date(arg('before')) : oldest;
const json = (v) => {
  if (!v || v === 'NULL') return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
};

let inserted = 0;
let skipped = 0;
for (const r of rows) {
  const publishedAt = new Date(`${r.publishedAt.replace(' ', 'T')}Z`);
  if (!(publishedAt < before)) {
    skipped++;
    continue;
  }
  const exists = await prisma.sourcePost.findUnique({ where: { platform_externalId: { platform: 'X', externalId: r.externalId } } });
  if (exists) {
    skipped++;
    continue;
  }
  const attachments = json(r.attachments);
  const media = (attachments?.media ?? []).filter((m) => m.url);
  await prisma.sourcePost.create({
    data: {
      id: randomUUID(),
      platform: 'X',
      sourceAccount: r.sourceAccount,
      externalId: r.externalId,
      authorId: r.authorId || null,
      conversationId: r.conversationId || r.externalId,
      text: r.text,
      noteTweetText: r.noteTweetText && r.noteTweetText !== 'NULL' ? r.noteTweetText : null,
      language: r.language || null,
      publishedAt,
      publicMetrics: json(r.publicMetrics),
      attachments,
      rawPayload: json(r.rawPayload),
      updatedAt: new Date(),
      PostMedia: {
        create: media.map((m) => ({
          id: randomUUID(),
          mediaKey: m.media_key,
          mediaType: m.type,
          url: m.url,
          width: m.width ?? null,
          height: m.height ?? null,
        })),
      },
    },
  });
  inserted++;
}
console.log(`CSV rows ${rows.length}: inserted ${inserted}, skipped ${skipped} (cutoff ${before.toISOString()})`);
console.log('posts now:', await prisma.sourcePost.count());
await prisma.$disconnect();
