import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const withDatabase = (url, name) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  u.search = '';
  return u.toString();
};

export default async function setup() {
  const base = process.env.TEST_DATABASE_SERVER_URL ?? process.env.DATABASE_URL;
  if (!base) throw new Error('Set DATABASE_URL (or TEST_DATABASE_SERVER_URL) so a disposable test database can be created on that server.');
  const name = `gridwatch_test_${Date.now()}_${randomBytes(3).toString('hex')}`;
  const admin = new PrismaClient({ datasourceUrl: withDatabase(base, 'postgres') });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  await admin.$disconnect();

  const url = withDatabase(base, name);
  const migrate = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { cwd: API, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
  if (migrate.status !== 0) {
    const cleanup = new PrismaClient({ datasourceUrl: withDatabase(base, 'postgres') });
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await cleanup.$disconnect();
    throw new Error(`migration chain failed on a clean database:\n${migrate.stdout}\n${migrate.stderr}`);
  }
  process.env.DATABASE_URL = url;
  process.env.GW_TEST_DATABASE_NAME = name;

  return async () => {
    const drop = new PrismaClient({ datasourceUrl: withDatabase(base, 'postgres') });
    await drop.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await drop.$disconnect();
  };
}
