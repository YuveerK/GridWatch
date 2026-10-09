// The self-correction engine's operator CLI (docs/CLAUDE_SELF_CORRECTING_ENGINE_IMPLEMENTATION.md §14).
// Preview:  node scripts/self-correct.js --preview [--service=WATER] [--post=<externalId>] [--limit=N]
// Shadow:   node scripts/self-correct.js --shadow [--limit=N]           (persists proposal records only; SELF_CORRECTION_MODE must not be "off")
// Inspect:  node scripts/self-correct.js --inspect=<proposalId>
// Report:   node scripts/self-correct.js --report [--since=<ISO-time>]
// Apply:    node scripts/self-correct.js --apply --proposal=<id>        (enforces every invariant/eligibility/lease/evidence check; refuses ineligible/ambiguous)
// Recover:  node scripts/self-correct.js --recover --attempt=<id>
// Preview is read-only and provider-free. Shadow persists only self-correction records - it never alters a reading,
// incident, graph, override, review resolution or notification. Exit codes: 0 ok, 2 invalid input, 3 busy/deferred,
// 4 rejected/ineligible, 5 failed/recovery-required.
const { prisma } = await import('../src/db/prisma.js');
const { env } = await import('../src/config/env.js');
const { previewProposals, runShadow } = await import('../src/modules/self-correction/service.js');
const { applyProposal, recoverAttempt } = await import('../src/modules/self-correction/executor.js');
const { summarizeByFamily, summarizeByStatus } = await import('../src/modules/self-correction/metrics.js');
const { PIPELINE, withLease } = await import('../src/modules/coordination/lease.js');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name) => process.argv.includes(`--${name}`);

function printDraft(d) {
  console.log(`  [${d.policyName}@${d.policyVersion}] ${d.triggerFamily}: ${d.action.type} ${d.postId}#${d.faultIndex}`);
  console.log(`    ${d.expectedEffect.summary}`);
}

async function preview() {
  const service = arg('service');
  const externalId = arg('post');
  const limit = Number(arg('limit') ?? env.SELF_CORRECTION_MAX_PROPOSALS_PER_CYCLE);
  let postIds = null;
  if (externalId) {
    const post = await prisma.sourcePost.findFirst({ where: { externalId }, select: { id: true } });
    if (!post) { console.error(`no post with externalId ${externalId}`); process.exitCode = 2; return; }
    postIds = [post.id];
  }
  const drafts = await previewProposals({ prisma, postIds, service, limit });
  console.log(`${drafts.length} candidate repair proposal(s) (read-only preview, nothing persisted):`);
  for (const d of drafts) printDraft(d);
}

async function shadow() {
  if (env.SELF_CORRECTION_MODE === 'off') {
    console.log('SELF_CORRECTION_MODE=off: nothing generated or persisted. Set SELF_CORRECTION_MODE=shadow to persist proposal records.');
    return;
  }
  const limit = Number(arg('limit') ?? env.SELF_CORRECTION_MAX_PROPOSALS_PER_CYCLE);
  const result = await runShadow({ prisma, limit, mode: env.SELF_CORRECTION_MODE });
  console.log(`generated ${result.generated}, persisted ${result.persisted} new, ${result.skipped} already existed (idempotent)`);
  for (const p of result.proposals) console.log(`  ${p.id} [${p.status}] ${p.action} ${p.postId}#${p.faultIndex} eligible=${p.eligibility?.eligible ?? false}`);
}

async function inspect(id) {
  const p = await prisma.repairProposal.findUnique({ where: { id }, include: { attempts: true, directive: true } });
  if (!p) { console.error(`no proposal ${id}`); process.exitCode = 2; return; }
  const post = await prisma.sourcePost.findUnique({ where: { id: p.postId }, select: { externalId: true, text: true, serviceType: true, sourceAccount: true } });
  console.log(`RepairProposal ${p.id}  status=${p.status}  action=${p.action}  policy=${p.policyName}@${p.policyVersion}`);
  console.log(`  post ${post?.externalId} (${p.sourceAccount}, ${p.serviceType})  fault ${p.faultIndex}  family: ${p.triggerFamily}`);
  console.log(`  before: ${JSON.stringify(p.beforePreview)}`);
  console.log(`  after (predicted unless applied): ${JSON.stringify(p.afterPreview)}`);
  console.log(`  evidence: ${JSON.stringify(p.evidence, null, 2)}`);
  console.log(`  eligibility: ${JSON.stringify(p.eligibility)}`);
  console.log(`  fingerprints: content=${p.sourceContentHash} layout=${p.sourceLayoutHash} candidates=${p.candidateStateFingerprint} lessons=${p.lessonSetFingerprint}`);
  console.log(`  attempts: ${p.attempts.length}`);
  for (const a of p.attempts) console.log(`    #${a.attemptNumber} ${a.outcome} snapshot=${a.snapshotRef ?? 'none'} ${a.startedAt.toISOString()}`);
  if (p.directive) console.log(`  auto repair directive: status=${p.directive.status} anchor=${p.directive.targetAnchorPostId}#${p.directive.targetAnchorFaultIndex}`);
}

async function report() {
  const sinceArg = arg('since');
  const since = sinceArg ? new Date(sinceArg) : new Date(Date.now() - 24 * 3_600_000);
  const rows = await prisma.repairProposal.findMany({ where: { createdAt: { gte: since } }, select: { status: true, policyName: true, policyVersion: true, serviceType: true, sourceAccount: true } });
  console.log(`self-correction report since ${since.toISOString()} (mode=${env.SELF_CORRECTION_MODE}):`);
  console.log(`  ${rows.length} proposal(s) total`);
  for (const [status, n] of Object.entries(summarizeByStatus(rows))) console.log(`    ${status}: ${n}`);
  console.log('  by service/source/policy (raw numerators, never a rate alone):');
  for (const f of summarizeByFamily(rows)) console.log(`    ${f.serviceType} ${f.sourceAccount} ${f.policyName}@${f.policyVersion}: ${f.total} (${JSON.stringify(f.byStatus)})`);
  console.log('  release gates: no independent adjudication pipeline exists yet in this release - every policy family therefore remains shadow-only by design (see §15 of the design doc).');
}

async function apply() {
  const id = arg('proposal');
  if (!id) { console.error('--apply needs --proposal=<id>'); process.exitCode = 2; return; }
  const result = await withLease(PIPELINE, (ctx) => applyProposal({ prisma, proposalId: id, ctx }));
  if (!result.acquired) { console.error('pipeline lease is held; nothing changed'); process.exitCode = 3; return; }
  console.log(JSON.stringify(result.value, null, 2));
  if (result.value.outcome === 'DEFERRED' || result.value.outcome === 'NEEDS_REVIEW') process.exitCode = 3;
  else if (result.value.outcome === 'REJECTED') process.exitCode = 4;
  else if (result.value.outcome === 'FAILED' || result.value.outcome === 'RECOVERY_REQUIRED') process.exitCode = 5;
}

async function recover() {
  const id = arg('attempt');
  if (!id) { console.error('--recover needs --attempt=<id>'); process.exitCode = 2; return; }
  const result = await withLease(PIPELINE, (ctx) => recoverAttempt({ prisma, attemptId: id, ctx }));
  if (!result.acquired) { console.error('pipeline lease is held; nothing changed'); process.exitCode = 3; return; }
  console.log(JSON.stringify(result.value, null, 2));
  if (result.value.outcome !== 'RECOVERED') process.exitCode = 5;
}

try {
  if (flag('preview')) await preview();
  else if (flag('shadow')) await shadow();
  else if (arg('inspect') !== undefined) await inspect(arg('inspect'));
  else if (flag('report')) await report();
  else if (flag('apply')) await apply();
  else if (flag('recover')) await recover();
  else {
    console.log('usage: self-correct.js --preview | --shadow | --inspect=<id> | --report | --apply --proposal=<id> | --recover --attempt=<id>');
    process.exitCode = 2;
  }
} finally {
  await prisma.$disconnect();
}
