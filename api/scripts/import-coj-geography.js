// Merge the City of Johannesburg CGIS area dataset (docs/Johannesburg/build_johannesburg_area_dataset.py)
// into the existing suburb geography. This does not replace johannesburg.txt / seed-geography.js; it enriches
// what's already there and adds official base suburbs GridWatch hasn't seen in a post yet. See
// src/lib/gis-import.js for the matching rules (shared with other municipalities' importers).
//
//   npm run import:coj-gis -- --in <dir-with-johannesburg_area_index.json> [--dry-run]
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prisma } from '../src/db/prisma.js';
import { importGisAreas } from '../src/lib/gis-import.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const inIdx = args.indexOf('--in');
const inDir = resolve(inIdx >= 0 ? args[inIdx + 1] : './coj-gis-output');
const file = resolve(inDir, 'johannesburg_area_index.json');

const records = JSON.parse(await readFile(file, 'utf8'));
const municipality = await prisma.municipality.findUnique({ where: { code: 'JOHANNESBURG' } });
if (!municipality) throw new Error("No Municipality row with code 'JOHANNESBURG' - run the Municipality migration first.");

const stats = await importGisAreas({
  records,
  municipalityId: municipality.id,
  baseTypes: new Set(['township_or_suburb', 'estate_or_township']),
  source: 'coj-cgis',
  primarySupplierName: 'City Power',
  dryRun,
});

console.log(dryRun ? '[dry run] nothing written' : 'import complete', {
  source: file,
  baseSuburbs: { matched: stats.baseMatched, created: stats.baseCreated },
  extensionsZonesHoldings: { matchedExisting: stats.extMatchedExisting, foldedIntoParentAsAliases: stats.extFoldedIntoParent, skippedNoMatchOrParent: stats.extSkipped },
  coordsBackfilled: stats.coordsBackfilled,
  electricitySupplierSet: stats.suppliersSet,
  boundariesSet: stats.boundariesSet,
  aliasesAdded: stats.aliasesAdded,
  ambiguousAcrossRegions: stats.ambiguous.length,
});

if (stats.nonPrimarySupplier.size) {
  console.log(`\n${stats.nonPrimarySupplier.size} known suburb(s) are not purely City Power territory (worth a look):`);
  for (const [name, supplier] of stats.nonPrimarySupplier) console.log(`  ${name}: ${supplier}`);
}

await prisma.$disconnect();
