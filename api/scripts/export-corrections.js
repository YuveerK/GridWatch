// Turn the manual corrections stored in the database into permanent test cases (tests/golden/corrections.json).
//   node scripts/export-corrections.js            report what would be added
//   node scripts/export-corrections.js --write    add it to the file
// correct-link.js does this by itself after every applied correction; run this to catch up on older ones.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/db/prisma.js';
import { mergePairs, pairsFromOverrides } from '../src/modules/outages/corrections.js';

export const FILE = fileURLToPath(new URL('../tests/golden/corrections.json', import.meta.url));

export function readFile() {
  return fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { _note: '', _kind: 'regression', pairs: [] };
}

/** Add the current corrections to the file. Returns { added, needContrast }. */
export async function exportCorrections({ write = false } = {}) {
  const rows = await prisma.linkOverride.findMany({
    include: { post: { select: { externalId: true } }, anchor: { select: { externalId: true } }, contrast: { select: { externalId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const { pairs, needContrast } = pairsFromOverrides(rows.map((r) => ({ postExternalId: r.post.externalId, faultIndex: r.faultIndex, action: r.action, anchorExternalId: r.anchor?.externalId, anchorFaultIndex: r.anchorFaultIndex, contrastExternalId: r.contrast?.externalId, note: r.note })));
  const file = readFile();
  const { pairs: merged, added } = mergePairs(file.pairs ?? [], pairs);
  if (write && added.length) fs.writeFileSync(FILE, `${JSON.stringify({ ...file, pairs: merged }, null, 2)}\n`);
  return { added, needContrast, total: merged.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const write = process.argv.includes('--write');
  const r = await exportCorrections({ write });
  console.log(`${write ? 'Added' : 'Would add'} ${r.added.length} pair(s); the file now has ${r.total}.`);
  for (const p of r.added) console.log(`  ${p.same ? 'same     ' : 'different'}  ${p.a.slice(-8)}${p.fa ? `#${p.fa}` : ''}  ${p.b.slice(-8)}  - ${p.why}`);
  if (r.needContrast.length) console.log(`\n${r.needContrast.length} split(s) have no "--from" post, so they cannot be a test yet: ${r.needContrast.map((x) => x.slice(-8)).join(', ')}\n  (re-run: node scripts/correct-link.js <post> --split --from <the post it was wrongly joined with> --apply)`);
  await prisma.$disconnect();
}
