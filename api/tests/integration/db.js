import { prisma } from '../../src/db/prisma.js';

/** Refuse to touch anything that is not a disposable test database. */
export function assertDisposable() {
  const name = new URL(process.env.DATABASE_URL).pathname.slice(1);
  if (!/^gridwatch_test_\d+_[0-9a-f]{6}$/.test(name)) throw new Error(`refusing to run against "${name}": not a disposable test database`);
  return name;
}

const TABLES = ['LinkDecision', 'OutagePost', 'OutageLocality', 'OutageNode', 'Outage', 'NodeLocality', 'InfraEdge', 'NodeAlias', 'InfraNode', 'PostSummary', 'PostExtraction', 'PostMedia', 'IngestionRunPost', 'IngestionRun', 'SourcePost', 'SourceAccount', 'IngestionLease', 'IngestionState', 'EvidenceContribution', 'WorkLease', 'NotificationEvent', 'PushSubscription', 'PushDevice', 'Locality'];

export async function resetDb() {
  assertDisposable();
  for (const t of TABLES) await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${t}" CASCADE`).catch(() => {});
}

export { prisma };
