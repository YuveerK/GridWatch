// Merge the City of Tshwane GeoWeb area dataset (docs/Tshwane/build_tshwane_area_dataset.py) into the
// suburb geography, the same way import-coj-geography.js does for Johannesburg. See src/lib/gis-import.js
// for the matching rules. Tshwane's dataset carries no electricity-supply signal (see
// docs/Gauteng/GRIDWATCH_GAUTENG_EXPANSION_RESEARCH.md), so electricitySupplier is simply left unset here.
//
//   npm run import:tshwane-gis -- --in <dir-with-tshwane_area_index.json> [--dry-run]
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prisma } from '../src/db/prisma.js';
import { importGisAreas } from '../src/lib/gis-import.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const inIdx = args.indexOf('--in');
const inDir = resolve(inIdx >= 0 ? args[inIdx + 1] : './tshwane-gis-output');
const file = resolve(inDir, 'tshwane_area_index.json');

const records = JSON.parse(await readFile(file, 'utf8'));
const municipality = await prisma.municipality.findUnique({ where: { code: 'TSHWANE' } });
if (!municipality) throw new Error("No Municipality row with code 'TSHWANE' - run scripts/seed-source-account.js for Tshwane first.");

const stats = await importGisAreas({
  records,
  municipalityId: municipality.id,
  baseTypes: new Set(['township_or_suburb']),
  source: 'tshwane-gis',
  dryRun,
});

console.log(dryRun ? '[dry run] nothing written' : 'import complete', {
  source: file,
  baseSuburbs: { matched: stats.baseMatched, created: stats.baseCreated },
  extensionsAndHoldings: { matchedExisting: stats.extMatchedExisting, foldedIntoParentAsAliases: stats.extFoldedIntoParent, skippedNoMatchOrParent: stats.extSkipped },
  coordsBackfilled: stats.coordsBackfilled,
  boundariesSet: stats.boundariesSet,
  aliasesAdded: stats.aliasesAdded,
  ambiguousAcrossRegions: stats.ambiguous.length,
});

await prisma.$disconnect();
