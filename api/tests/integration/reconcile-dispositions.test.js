import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeEach, expect, it } from 'vitest';
import { prisma, resetDb, assertDisposable } from './db.js';
import { env } from '../../src/config/env.js';

const API = fileURLToPath(new URL('../../', import.meta.url));
beforeEach(resetDb);

it('previews without writing and rolls back a failed disposition repair', async () => {
  assertDisposable();
  const at = new Date('2026-09-10T12:00:00Z');
  await prisma.sourcePost.create({ data: { id: 'repair-post', externalId: 'repair-test', sourceAccount: 'Test', text: 'An outage with no location', publishedAt: at, updatedAt: at, processingStatus: 'RELEVANT' } });
  await prisma.postExtraction.create({ data: {
    postId: 'repair-post', promptVersion: env.AI_PROMPT_VERSION, status: 'SUCCEEDED', relevance: 'OUTAGE', model: 'test',
    result: { relevance: 'OUTAGE', status: 'INVESTIGATING', entities: [], localities: [], faults: [], confidence: 1 },
  } });
  await prisma.linkDecision.createMany({ data: [0, 1].map((faultIndex) => ({ postId: 'repair-post', faultIndex, outcome: 'NEW', reason: 'old notice disposition' })) });
  const before = await prisma.linkDecision.findMany({ orderBy: { faultIndex: 'asc' } });
  const run = (...args) => spawnSync(process.execPath, ['scripts/reconcile-dispositions.js', '--post=repair-test', ...args], {
    cwd: API, encoding: 'utf8', env: { ...process.env, GRIDWATCH_NO_AI: '1', SCHEDULER: 'off', LOG_LEVEL: 'silent' },
  });
  const preview = run();
  expect(preview.status, preview.stderr).toBe(0);
  expect(preview.stdout).toContain('1 inconsistent posts; 1 selected');
  expect(await prisma.linkDecision.findMany({ orderBy: { faultIndex: 'asc' } })).toEqual(before);
  const repair = run('--apply');
  expect(repair.status).toBe(1);
  expect(repair.stderr).toContain('Restoring this batch after failure');
  expect(repair.stdout).toContain('Snapshot:');
  expect((await prisma.linkDecision.findMany({ orderBy: { faultIndex: 'asc' } })).map(({ faultIndex, outcome, reason }) => ({ faultIndex, outcome, reason })))
    .toEqual(before.map(({ faultIndex, outcome, reason }) => ({ faultIndex, outcome, reason })));
  expect((await prisma.sourcePost.findUnique({ where: { id: 'repair-post' } })).processingStatus).toBe('RELEVANT');
  expect(await prisma.workLease.count()).toBe(0);
});
