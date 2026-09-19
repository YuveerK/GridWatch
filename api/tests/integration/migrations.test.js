import { describe, expect, it } from 'vitest';
import { assertDisposable, prisma } from './db.js';

describe('clean migration chain', () => {
  it('applied every migration to a fresh database and produces the schema the code expects', async () => {
    const name = assertDisposable();
    const applied = await prisma.$queryRaw`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name`;
    expect(applied.length).toBeGreaterThanOrEqual(9);
    const tables = (await prisma.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`).map((r) => r.table_name);
    for (const t of ['SourcePost', 'Outage', 'OutagePost', 'LinkDecision', 'IngestionLease', 'PostExtraction']) expect(tables).toContain(t);
    expect(name).toMatch(/^gridwatch_test_/);
  });
});
