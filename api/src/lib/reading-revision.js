import { createHash } from 'node:crypto';

// A short fingerprint of everything in a reading that can change what the engine does with a post: how it is classified, its status,
// percentage, cause and estimate, the equipment and suburbs it names (with their states), and the same for each fault of a graphic.
// The wording (summary, image transcription) and the reader's own stamp are left out: they change without changing any outage.
// Stored on each outage effect, it lets a change of reading be noticed later even when the fault count and classification stay the same.

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const list = (xs, pick) => (xs ?? []).map(pick).sort();
const entity = (e) => `${norm(e.type)}:${norm(e.name)}<${norm(e.parent_name)}`;
const waterEntity = (e) => `${entity(e)}:${norm(e.operator)}:${norm(e.relationType)}`;
const place = (l) => `${norm(l.name)}:${norm(l.state)}`;

function fault(f, legacyWater = false) {
  const out = {
    status: norm(f.status),
    pct: f.restoration_percent ?? null,
    cause: norm(f.cause),
    eta: norm(f.eta_text),
    equipment: list(f.equipment, entity),
    localities: list(f.localities, place),
  };
  if (!legacyWater && (f.water_state !== undefined || f.customer_supply !== undefined || f.entities !== undefined)) {
    out.waterState = norm(f.water_state);
    out.customerSupply = norm(f.customer_supply);
    out.entities = list(f.entities, waterEntity);
    out.impacts = list(f.localities, (l) => `${norm(l.name)}:${norm(l.impact)}`);
  }
  return out;
}

/** The fingerprint (16 hex characters) of a stored reading, or null when there is none. */
export function readingRevision(result, { legacyWater = false } = {}) {
  if (!result) return null;
  const parts = {
    relevance: norm(result.relevance),
    status: norm(result.status),
    pct: result.restoration_percent ?? null,
    cause: norm(result.cause),
    eta: norm(result.eta_text),
    sdc: norm(result.sdc),
    entities: list(result.entities, entity),
    localities: list(result.localities, place),
    faults: (result.faults ?? []).map((f) => fault(f, legacyWater)), // order matters: a fault's number is part of its identity
  };
  if (!legacyWater && (result.water_state !== undefined || result.customer_supply !== undefined)) {
    parts.water = {
      state: norm(result.water_state), customerSupply: norm(result.customer_supply),
      entities: list(result.entities, waterEntity),
      impacts: list(result.localities, (l) => `${norm(l.name)}:${norm(l.impact)}`),
    };
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}
