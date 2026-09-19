// Load the Johannesburg regions and suburbs from data/johannesburg.txt (or GEOGRAPHY_FILE).
// Additive and idempotent: existing suburbs (and the coordinates learned for them) are kept, new ones are added.
//   npm run seed:geography -- --dry-run     parse and report only; the database is not touched
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prisma } from '../src/db/prisma.js';
import { collisions, parseGeographyText } from '../src/lib/geography-seed.js';

const dryRun = process.argv.includes('--dry-run');
const file = resolve(process.env.GEOGRAPHY_FILE ?? new URL('../data/johannesburg.txt', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const regions = parseGeographyText(await readFile(file, 'utf8'));
const report = { file, regions: regions.length, suburbs: regions.reduce((n, r) => n + r.localities.length, 0), crossRegion: collisions(regions).length, created: 0, existing: 0 };

if (!dryRun) {
  const already = await prisma.locality.count();
  if (already > 0 && !process.argv.includes('--force')) {
    console.error(`The database already has ${already} suburbs (with learned coordinates). This is meant for an empty database; use --dry-run to see what it would add, or --force to add the missing ones anyway.`);
    await prisma.$disconnect();
    process.exit(1);
  }
  for (const r of regions) {
    const region = await prisma.region.upsert({ where: { code: r.code }, update: { name: r.name }, create: { id: randomUUID(), code: r.code, name: r.name } });
    for (const l of r.localities) {
      const found = await prisma.locality.findUnique({ where: { regionId_normalizedName: { regionId: region.id, normalizedName: l.normalizedName } }, select: { id: true } });
      if (found) {
        report.existing += 1;
        continue;
      }
      await prisma.locality.create({ data: { id: randomUUID(), canonicalName: l.name, normalizedName: l.normalizedName, regionId: region.id, sourceLabel: l.name, sourceLine: l.sourceLine, updatedAt: new Date() } });
      report.created += 1;
    }
  }
}
console.log(dryRun ? { dryRun: true, ...report } : report);
await prisma.$disconnect();
