// Gemini tie-break verdicts are cached on disk so replays are deterministic and free.
// Key = post id + the earliest post of each shortlisted outage (stable across replays).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const FILE = new URL('../../../.cache/tiebreak.json', import.meta.url);
let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
  } catch {
    cache = {};
  }
  return cache;
}

export function cachedVerdict(key) {
  return load()[key];
}

export function storeVerdict(key, verdict) {
  load()[key] = verdict;
  try {
    mkdirSync(dirname(FILE.pathname.replace(/^\/([A-Za-z]:)/, '$1')), { recursive: true });
    writeFileSync(FILE, JSON.stringify(cache, null, 1));
  } catch {
    /* cache is best-effort */
  }
}
