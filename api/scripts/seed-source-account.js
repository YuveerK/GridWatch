// Add (or update) a polled X account and the municipality/utility it belongs to. This is the "registry" of
// tracked sources - a SourceAccount row, not a separate config file - so ingestion picks it up automatically
// on its next run (see getActiveAccounts() in ingestion.service.js).
//
//   node scripts/seed-source-account.js --handle CityTshwane --external-id 149052206 \
//     --municipality-code TSHWANE --municipality-name "City of Tshwane"
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/db/prisma.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

const handle = flag('handle');
const externalId = flag('external-id');
const municipalityCode = flag('municipality-code');
const municipalityName = flag('municipality-name');

if (!handle || !externalId || !municipalityCode || !municipalityName) {
  console.error('Usage: node scripts/seed-source-account.js --handle <X handle> --external-id <numeric X user id> --municipality-code <CODE> --municipality-name "<Name>"');
  process.exit(1);
}

const municipality = await prisma.municipality.upsert({
  where: { code: municipalityCode },
  create: { id: randomUUID(), name: municipalityName, code: municipalityCode },
  update: { name: municipalityName },
});

const account = await prisma.sourceAccount.upsert({
  where: { externalId },
  create: { id: randomUUID(), platform: 'X', externalId, displayName: handle, municipalityId: municipality.id, updatedAt: new Date() },
  update: { displayName: handle, municipalityId: municipality.id, active: true },
});

console.log({ municipality, account });
await prisma.$disconnect();
