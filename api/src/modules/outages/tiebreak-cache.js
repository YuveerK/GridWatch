// Gemini tie-break verdicts are cached on disk so replays are deterministic and free.
// The key (built by the linker) fingerprints the post, the model and every candidate by its stable origin, so an
// entry can only be reused for the identical question. Older v4/v5 entries used ambiguous candidate ids and are ignored.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = process.env.TIEBREAK_CACHE_FILE || fileURLToPath(new URL('../../../.cache/tiebreak.json', import.meta.url));
let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
  } catch {
    cache = {}; // unreadable or half-written: start again, it only costs a re-ask
  }
  return cache;
}

export function cachedVerdict(key) {
  return load()[key];
}

export function storeVerdict(key, verdict) {
  load()[key] = verdict;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 1)); // write beside, then swap in: a crash never leaves a torn file
    renameSync(tmp, FILE);
  } catch {
    /* cache is best-effort */
  }
}

/** For tests: forget the in-memory copy. */
export function resetTiebreakCache() {
  cache = null;
}
