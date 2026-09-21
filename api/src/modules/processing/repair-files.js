import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'backups');

/** Write a repair snapshot to data/backups/repair-<time>-<label>.json and return its path. */
export function saveSnapshotFile(snapshot, label = 'repair', extras = null) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `repair-${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...snapshot, ...(extras ? { extras } : {}) }));
  return file;
}

export const loadSnapshotFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
