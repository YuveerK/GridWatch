// Reviewed-lesson operator CLI (docs/CLAUDE_SELF_CORRECTING_ENGINE_IMPLEMENTATION.md §14).
// Import:  node scripts/correction-lessons.js --import-existing --preview
//          node scripts/correction-lessons.js --import-existing --apply
// List:    node scripts/correction-lessons.js --list [--status=ACTIVE]
// Inspect: node scripts/correction-lessons.js --inspect=<id>
// Promote: node scripts/correction-lessons.js --promote=<id> --to=REVIEWED|ACTIVE
// Retire:  node scripts/correction-lessons.js --retire=<id> --reason="..."
// Import creates CANDIDATE lessons only - promotion to REVIEWED/ACTIVE is always a separate, explicit step. No
// lesson is ever auto-promoted, and none of these commands change an incident, reading or graph identity.
const { prisma } = await import('../src/db/prisma.js');
const { importExistingCorrections, setLessonStatus } = await import('../src/modules/self-correction/lessons.js');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name) => process.argv.includes(`--${name}`);

async function importCmd() {
  const apply = flag('apply');
  const result = await importExistingCorrections({ prisma, dryRun: !apply });
  if (!apply) {
    console.log(`preview: ${result.created.length} new candidate lesson(s) would be created, ${result.skipped.length} already imported, ${result.total} human corrections total`);
    for (const c of result.created) console.log(`  [${c.kind}] ${c.postId}#${c.faultIndex}: ${c.note ?? '(no note)'}`);
    return;
  }
  console.log(`created ${result.created.length} candidate lesson(s), ${result.skipped.length} already existed, ${result.total} human corrections total`);
  for (const l of result.created) console.log(`  ${l.id} [${l.kind}] ${l.serviceType} ${l.sourceAccountScope}`);
}

async function list() {
  const status = arg('status');
  const rows = await prisma.correctionLesson.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 100 });
  console.log(`${rows.length} lesson(s)${status ? ` [${status}]` : ''}:`);
  for (const l of rows) console.log(`  ${l.id} [${l.status}] ${l.kind} ${l.serviceType} ${l.sourceAccountScope ?? '(any source)'} v${l.version} support=${l.independentSupportCount}`);
}

async function inspect(id) {
  const l = await prisma.correctionLesson.findUnique({ where: { id }, include: { supports: true } });
  if (!l) { console.error(`no lesson ${id}`); process.exitCode = 2; return; }
  console.log(`CorrectionLesson ${l.id}  status=${l.status}  kind=${l.kind}  v${l.version}`);
  console.log(`  scope: ${l.serviceType} / municipality=${l.municipalityId ?? 'any'} / source=${l.sourceAccountScope ?? 'any'}`);
  console.log(`  claim: ${JSON.stringify(l.claim)}`);
  console.log(`  applicability: ${JSON.stringify(l.applicabilityPredicate)}`);
  console.log(`  exclusions: ${JSON.stringify(l.exclusions)}`);
  console.log(`  established by: ${l.establishedBy}`);
  console.log(`  effective: ${l.effectiveAt.toISOString()}  reviewed: ${l.reviewedAt?.toISOString() ?? 'never'}  expires: ${l.expiresAt?.toISOString() ?? 'never'}`);
  console.log(`  independent support count: ${l.independentSupportCount}`);
  for (const s of l.supports) console.log(`    ${s.role} ${s.postId}#${s.faultIndex}`);
  if (l.revocationReason) console.log(`  revocation reason: ${l.revocationReason}`);
}

async function promote(id) {
  const to = arg('to');
  if (!to) { console.error('--promote needs --to=REVIEWED|ACTIVE|SUSPENDED|RETIRED'); process.exitCode = 2; return; }
  const l = await setLessonStatus({ prisma, id, status: to, reason: arg('reason') ?? null });
  console.log(`${l.id} -> ${l.status}`);
}

async function retire(id) {
  const reason = arg('reason');
  if (!reason) { console.error('--retire needs --reason="..."'); process.exitCode = 2; return; }
  const l = await setLessonStatus({ prisma, id, status: 'RETIRED', reason });
  console.log(`${l.id} -> RETIRED (${reason})`);
}

try {
  if (flag('import-existing')) await importCmd();
  else if (flag('list')) await list();
  else if (arg('inspect') !== undefined) await inspect(arg('inspect'));
  else if (arg('promote') !== undefined) await promote(arg('promote'));
  else if (arg('retire') !== undefined) await retire(arg('retire'));
  else {
    console.log('usage: correction-lessons.js --import-existing [--apply] | --list [--status=X] | --inspect=<id> | --promote=<id> --to=STATUS | --retire=<id> --reason="..."');
    process.exitCode = 2;
  }
} finally {
  await prisma.$disconnect();
}
