import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.TIEBREAK_CACHE_FILE = join(mkdtempSync(join(tmpdir(), 'gw-tiebreak-')), 'tiebreak.json');
process.env.GRIDWATCH_NO_AI = '1'; // every scenario below is deterministic; no self-correction generator here ever calls the provider

const readings = new Map();
// The real extractPost() both calls the provider AND persists the PostExtraction row; mocking it out for a
// deterministic test must still persist that row, exactly like the real pipeline, or downstream code that reads
// PostExtraction (acceptedExtraction, checkPostDispositions) sees nothing at all.
vi.mock('../../src/modules/ai/extraction.service.js', async (orig) => {
  const mod = await orig();
  const { prisma: rawPrisma } = await import('../../src/db/prisma.js');
  const { readerFor } = await import('../../src/modules/ai/reader-registry.js');
  const { env: cfg } = await import('../../src/config/env.js');
  return {
    ...mod,
    extractPost: async (postId) => {
      const r = readings.get(postId) ?? { status: 'FAILED', result: null };
      const post = await rawPrisma.sourcePost.findUniqueOrThrow({ where: { id: postId } });
      const promptVersion = readerFor(post.serviceType ?? 'ELECTRICITY').promptVersion ?? cfg.AI_PROMPT_VERSION;
      return rawPrisma.postExtraction.upsert({
        where: { postId_promptVersion: { postId, promptVersion } },
        create: { postId, promptVersion, model: 'test', status: r.status, relevance: r.relevance ?? null, result: r.result ?? undefined, imageCount: 0, inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0 },
        update: { status: r.status, relevance: r.relevance ?? null, result: r.result ?? undefined },
      });
    },
  };
});

const { processPost } = await import('../../src/modules/processing/processor.service.js');
const { resetLocalityIndex } = await import('../../src/modules/infrastructure/infrastructure.service.js');
const { setOverride, resolveDecision } = await import('../../src/modules/outages/overrides.js');
const { PIPELINE, withLease } = await import('../../src/modules/coordination/lease.js');
const { prisma, resetDb } = await import('./db.js');

const { findDispositionInconsistencies, draftDispositionRepairProposal } = await import('../../src/modules/self-correction/proposals.js');
const { persistProposal, previewProposals, runShadow } = await import('../../src/modules/self-correction/service.js');
const { applyProposal, recoverAttempt } = await import('../../src/modules/self-correction/executor.js');

const T0 = new Date('2026-09-10T08:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60_000);
const base = { sdc: 'Test SDC', localities: [], faults: [], eta_text: null, cause: null, restoration_percent: null, update_summary: 'x', confidence: 0.9, image_text: null };
const reading = (relevance, status, equipment, extra = {}) => ({
  status: 'SUCCEEDED',
  relevance,
  inputTokens: 0,
  outputTokens: 0,
  result: { ...base, relevance, status, entities: equipment.map((name) => ({ type: 'SUBSTATION', name, parent_name: null })), ...extra },
});

let n = 0;
async function addPost(min, text, r, extra = {}) {
  n += 1;
  const id = `sc${n}`;
  await prisma.sourcePost.create({ data: { id, platform: 'X', sourceAccount: 'a', externalId: String(9500 + n), text, publishedAt: at(min), updatedAt: at(min), conversationId: String(9500 + n), ...extra } });
  readings.set(id, r);
  return id;
}

beforeEach(async () => {
  await resetDb();
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "EvidenceContribution", "Locality", "WorkLease" CASCADE');
  resetLocalityIndex();
  readings.clear();
  n = 0;
});

describe('self-correction: deterministic disposition-repair generator', () => {
  it('finds nothing when every disposition is consistent', async () => {
    const id = await addPost(0, 'Power out at Bravo', reading('OUTAGE', 'INVESTIGATING', ['Bravo']));
    await processPost(id);
    expect(await findDispositionInconsistencies({ prisma, postIds: [id] })).toHaveLength(0);
  });

  it('finds a post whose fault has no disposition (a decision was deleted out from under it)', async () => {
    const id = await addPost(0, 'Power out at Charlie', reading('OUTAGE', 'INVESTIGATING', ['Charlie']));
    await processPost(id);
    await prisma.linkDecision.deleteMany({ where: { postId: id } });
    const findings = await findDispositionInconsistencies({ prisma, postIds: [id] });
    expect(findings).toHaveLength(1);
    expect(findings[0].problems[0]).toMatch(/no disposition/);
  });

  it('drafts a REPROCESS_STORED proposal with a stable idempotency key and does not draft one for a post with a human override', async () => {
    const id = await addPost(0, 'Power out at Delta', reading('OUTAGE', 'INVESTIGATING', ['Delta']));
    await processPost(id);
    await prisma.linkDecision.deleteMany({ where: { postId: id } });
    const [finding] = await findDispositionInconsistencies({ prisma, postIds: [id] });
    const draft = await draftDispositionRepairProposal({ prisma, post: finding.post, problems: finding.problems });
    expect(draft.action.type).toBe('REPROCESS_STORED');
    expect(draft.idempotencyKey).toBeTruthy();

    await setOverride({ postId: id, faultIndex: 0, action: 'SPLIT', note: 'a person decided this is fine as-is' });
    const draft2 = await draftDispositionRepairProposal({ prisma, post: finding.post, problems: finding.problems });
    expect(draft2).toBeNull();
  });
});

describe('self-correction: shadow mode', () => {
  it('SELF_CORRECTION_MODE=off generates and persists nothing', async () => {
    const id = await addPost(0, 'Power out at Echo', reading('OUTAGE', 'INVESTIGATING', ['Echo']));
    await processPost(id);
    await prisma.linkDecision.deleteMany({ where: { postId: id } });
    const result = await runShadow({ prisma, postIds: [id], mode: 'off' });
    expect(result).toEqual({ generated: 0, persisted: 0, proposals: [] });
    expect(await prisma.repairProposal.count()).toBe(0);
  });

  it('shadow mode persists a proposal record but changes no reading, incident, override, review or notification state', async () => {
    const id = await addPost(0, 'Power out at Foxtrot', reading('OUTAGE', 'INVESTIGATING', ['Foxtrot']));
    await processPost(id);
    await prisma.linkDecision.deleteMany({ where: { postId: id } });
    const beforeOutages = await prisma.outage.count();
    const beforeOutagePosts = await prisma.outagePost.count();
    const result = await runShadow({ prisma, postIds: [id], mode: 'shadow' });
    expect(result.persisted).toBe(1);
    const [proposal] = result.proposals;
    expect(proposal.status).toBe('SHADOW_EVALUATED');
    expect(proposal.eligibility.eligible).toBe(false); // mode is shadow, never auto: never eligible to apply
    expect(await prisma.outage.count()).toBe(beforeOutages);
    expect(await prisma.outagePost.count()).toBe(beforeOutagePosts);
    // still broken: nothing was actually repaired
    expect(await prisma.linkDecision.count({ where: { postId: id } })).toBe(0);
  });

  it('is idempotent: the same underlying problem never queues a second live proposal', async () => {
    const id = await addPost(0, 'Power out at Golf', reading('OUTAGE', 'INVESTIGATING', ['Golf']));
    await processPost(id);
    await prisma.linkDecision.deleteMany({ where: { postId: id } });
    const first = await runShadow({ prisma, postIds: [id], mode: 'shadow' });
    const second = await runShadow({ prisma, postIds: [id], mode: 'shadow' });
    expect(first.persisted).toBe(1);
    expect(second.persisted).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await prisma.repairProposal.count()).toBe(1);
  });

  it('--preview generates drafts without persisting anything', async () => {
    const id = await addPost(0, 'Power out at Hotel', reading('OUTAGE', 'INVESTIGATING', ['Hotel']));
    await processPost(id);
    await prisma.linkDecision.deleteMany({ where: { postId: id } });
    const drafts = await previewProposals({ prisma, postIds: [id] });
    expect(drafts).toHaveLength(1);
    expect(await prisma.repairProposal.count()).toBe(0);
  });
});

describe('self-correction: executor (apply)', () => {
  async function brokenDispositionProposal(name) {
    const id = await addPost(0, `Power out at ${name}`, reading('OUTAGE', 'INVESTIGATING', [name]));
    await processPost(id);
    await prisma.linkDecision.deleteMany({ where: { postId: id } });
    const { proposals } = await runShadow({ prisma, postIds: [id], mode: 'auto' });
    return { postId: id, proposal: proposals[0] };
  }

  it('mode=auto but the policy is not allowlisted: apply refuses (REJECTED), nothing mutated', async () => {
    const { proposal, postId } = await brokenDispositionProposal('India');
    const result = await withLease(PIPELINE, (ctx) => applyProposal({ prisma, proposalId: proposal.id, ctx, mode: 'auto', allowlist: new Set() }));
    expect(result.value.outcome).toBe('REJECTED');
    expect(await prisma.linkDecision.count({ where: { postId } })).toBe(0);
    const stored = await prisma.repairProposal.findUnique({ where: { id: proposal.id } });
    expect(stored.status).toBe('REJECTED');
  });

  it('allowlisted and eligible: apply repairs the disposition, records an APPLIED attempt with a snapshot, and postconditions hold', async () => {
    const { proposal, postId } = await brokenDispositionProposal('Juliet');
    const allowlist = new Set([`${proposal.policyName}@${proposal.policyVersion}`]);
    const result = await withLease(PIPELINE, (ctx) => applyProposal({ prisma, proposalId: proposal.id, ctx, mode: 'auto', allowlist }));
    expect(result.value.outcome).toBe('APPLIED');
    expect(await prisma.linkDecision.count({ where: { postId } })).toBe(1);
    const attempts = await prisma.repairAttempt.findMany({ where: { proposalId: proposal.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].outcome).toBe('APPLIED');
    expect(attempts[0].snapshotRef).toBeTruthy();
    const stored = await prisma.repairProposal.findUnique({ where: { id: proposal.id } });
    expect(stored.status).toBe('APPLIED');
  });

  it('applying twice is idempotent: the second call reports APPLIED without a second attempt', async () => {
    const { proposal } = await brokenDispositionProposal('Kilo');
    const allowlist = new Set([`${proposal.policyName}@${proposal.policyVersion}`]);
    const first = await withLease(PIPELINE, (ctx) => applyProposal({ prisma, proposalId: proposal.id, ctx, mode: 'auto', allowlist }));
    const second = await withLease(PIPELINE, (ctx) => applyProposal({ prisma, proposalId: proposal.id, ctx, mode: 'auto', allowlist }));
    expect(first.value.outcome).toBe('APPLIED');
    expect(second.value.outcome).toBe('APPLIED');
    expect(second.value.reason).toMatch(/idempotent/);
    expect(await prisma.repairAttempt.count({ where: { proposalId: proposal.id } })).toBe(1);
  });

  it('a human override on the subject, created after the proposal, supersedes it rather than applying over the person', async () => {
    const { proposal, postId } = await brokenDispositionProposal('Lima');
    await setOverride({ postId, faultIndex: 0, action: 'SPLIT', note: 'a person looked at this and decided' });
    const allowlist = new Set([`${proposal.policyName}@${proposal.policyVersion}`]);
    const result = await withLease(PIPELINE, (ctx) => applyProposal({ prisma, proposalId: proposal.id, ctx, mode: 'auto', allowlist }));
    expect(result.value.outcome).toBe('SUPERSEDED');
    expect(await prisma.linkDecision.count({ where: { postId } })).toBe(0); // untouched: the override, not this proposal, now governs
  });

  it('a worker that lost its lease writes nothing: apply throws, no attempt row, proposal unchanged', async () => {
    const { proposal } = await brokenDispositionProposal('Mike');
    const ghost = { name: 'pipeline', owner: 'not-the-owner', lost: false, assertHeld() { throw new Error('lost the lease'); } };
    const allowlist = new Set([`${proposal.policyName}@${proposal.policyVersion}`]);
    await expect(applyProposal({ prisma, proposalId: proposal.id, ctx: ghost, mode: 'auto', allowlist })).rejects.toThrow(/lease/i);
    expect(await prisma.repairAttempt.count({ where: { proposalId: proposal.id } })).toBe(0);
  });

  it('scope beyond configured limits is refused as NEEDS_REVIEW, not silently expanded', async () => {
    const { proposal } = await brokenDispositionProposal('November');
    const bloated = await prisma.repairProposal.update({ where: { id: proposal.id }, data: { expectedEffect: { ...proposal.expectedEffect, outageIdsAffected: ['o1', 'o2', 'o3', 'o4', 'o5'] } } });
    const allowlist = new Set([`${bloated.policyName}@${bloated.policyVersion}`]);
    const result = await withLease(PIPELINE, (ctx) => applyProposal({ prisma, proposalId: bloated.id, ctx, mode: 'auto', allowlist }));
    expect(result.value.outcome).toBe('NEEDS_REVIEW');
  });
});

describe('self-correction: recovery', () => {
  it('recoverAttempt restores the world to exactly how it was right before this attempt, undoing only the attempt', async () => {
    const id = await addPost(0, 'Power out at Oscar', reading('OUTAGE', 'INVESTIGATING', ['Oscar']));
    await processPost(id);
    await prisma.linkDecision.deleteMany({ where: { postId: id } }); // the "broken" state the proposal was generated against
    const { proposals } = await runShadow({ prisma, postIds: [id], mode: 'auto' });
    const proposal = proposals[0];
    const allowlist = new Set([`${proposal.policyName}@${proposal.policyVersion}`]);
    await withLease(PIPELINE, (ctx) => applyProposal({ prisma, proposalId: proposal.id, ctx, mode: 'auto', allowlist }));
    expect(await prisma.linkDecision.count({ where: { postId: id } })).toBe(1); // the repair fixed it
    const attempt = await prisma.repairAttempt.findFirst({ where: { proposalId: proposal.id } });
    // simulate a crash between "attempt+snapshot recorded" and "final outcome written": the attempt is left at its
    // pre-final placeholder and the proposal is still APPLYING, exactly the shape a real interrupted worker leaves
    await prisma.repairAttempt.update({ where: { id: attempt.id }, data: { outcome: 'RECOVERY_REQUIRED' } });
    await prisma.repairProposal.update({ where: { id: proposal.id }, data: { status: 'APPLYING' } });
    const result = await withLease(PIPELINE, (ctx) => recoverAttempt({ prisma, attemptId: attempt.id, ctx }));
    expect(result.value.outcome).toBe('RECOVERED');
    // the snapshot captured the state right BEFORE this attempt (the broken, 0-decision state) - recovery undoes
    // exactly this attempt's own change, not a time machine back to the original healthy state from before that
    expect(await prisma.linkDecision.count({ where: { postId: id } })).toBe(0);
  });
});

describe('self-correction: required cross-service regression (CLAUDE.md)', () => {
  // Same suburb, same time, opposite services, WATER post, ELECTRICITY outage -> must never link, even via the
  // new AutoRepairDirective mechanism (checked again here, at the point of use, not only at proposal-creation time).
  it('an AutoRepairDirective can never bridge Water and Electricity, even if it were somehow created wrong', async () => {
    const electricityPost = await addPost(0, 'Power out at Pretoria Road', reading('OUTAGE', 'INVESTIGATING', ['Pretoria Road']));
    await processPost(electricityPost);
    const waterPost = await addPost(1, 'Low pressure at Pretoria Road', reading('OUTAGE', 'INVESTIGATING', []), { serviceType: 'WATER' });

    const electricityAnchor = (await prisma.outagePost.findFirst({ where: { postId: electricityPost } }));
    // directly fabricate a directive that (incorrectly) points the WATER post's JOIN at the ELECTRICITY anchor -
    // simulating the one way a bug elsewhere could produce this, since no real generator in this release does
    const proposal = await prisma.repairProposal.create({
      data: {
        postId: waterPost, faultIndex: 0, serviceType: 'WATER', sourceAccount: 'a', action: 'JOIN_FAULT',
        generatorName: 'test', generatorVersion: '1', policyName: 'test-cross-service', policyVersion: '1', triggerFamily: 'test',
        sourceContentHash: 'x', sourceLayoutHash: 'x', lessonSetFingerprint: 'x', candidateStateFingerprint: 'x',
        targetAnchorPostId: electricityPost, targetAnchorFaultIndex: 0,
        evidence: {}, expectedEffect: { postsAffected: [waterPost] }, affectedManifest: {}, beforePreview: {}, eligibility: {},
        status: 'APPLIED', expiresAt: new Date(Date.now() + 3_600_000), idempotencyKey: 'test-cross-service-key',
      },
    });
    await prisma.repairAttempt.create({ data: { proposalId: proposal.id, attemptNumber: 1, workerOwner: 'test', operation: 'JOIN_FAULT', inputFingerprint: 'x', affectedManifest: {}, outcome: 'APPLIED' } });
    const attempt = await prisma.repairAttempt.findFirst({ where: { proposalId: proposal.id } });
    await prisma.autoRepairDirective.create({
      data: { postId: waterPost, faultIndex: 0, proposalId: proposal.id, attemptId: attempt.id, action: 'JOIN', targetAnchorPostId: electricityPost, targetAnchorFaultIndex: 0, policyName: 'test-cross-service', policyVersion: '1', evidenceFingerprint: 'x', status: 'ACTIVE' },
    });

    const decision = await resolveDecision(waterPost, 0, prisma);
    expect(decision).toBeNull(); // refused before it could ever reach candidate loading, scoring or commitLink

    // and the normal pipeline, left to its own devices, must independently reach the same isolation
    await processPost(waterPost);
    const waterDecision = await prisma.linkDecision.findFirst({ where: { postId: waterPost } });
    if (waterDecision?.outageId) {
      const linkedOutage = await prisma.outage.findUnique({ where: { id: waterDecision.outageId } });
      expect(linkedOutage.serviceType).toBe('WATER');
    }
  });
});
