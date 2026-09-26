// Matching suburbs that have no outline to official township polygons by name. Pure, so it is unit tested.
import { geometryCentre, geometryContains, interiorPoint } from './geo-contains.js';
import { baseNormalize } from './normalize.js';

const HOLDINGS = /\s+a\s?h$/; // "RIVERBEND A.H." (agricultural holdings) is the township a post calls "Riverbend"

/** A township/suburb name as a comparable key: "BLOUBOSRAND EXT.13" and "Bloubosrand Ext 13" -> "bloubosrand ext 13". */
export const townshipKey = (name) => baseNormalize(name);

/**
 * The townships one suburb name stands for. "Lawley Ext 1 & 2" is two townships; anything else is one.
 * Only the "<name> Ext N and M" shape is split, so an ordinary name containing "and" is never cut in two.
 */
export function nameParts(name) {
  const key = townshipKey(name);
  const m = key.match(/^(.+ ext) (\d+(?: and \d+)+)$/);
  return m ? m[2].split(' and ').map((n) => `${m[1]} ${n}`) : [key];
}

/** key -> [geometry] for one source's features, with the name taken by `nameOf(feature)`. */
export function indexByName(features, nameOf) {
  const index = new Map();
  for (const f of features) {
    const name = nameOf(f);
    if (!name || !f.geometry) continue;
    const key = townshipKey(name);
    index.set(key, [...(index.get(key) ?? []), f.geometry]);
  }
  return index;
}

const APART_DEG = 0.045; // ~5 km: pieces of one township sit together; the same name further apart is two places

/** True when one name's polygons lie so far apart that they are different places sharing a name. */
function scattered(geometries) {
  const centres = geometries.map(geometryCentre).filter(Boolean);
  return centres.some((a) => centres.some((b) => Math.hypot(a[0] - b[0], a[1] - b[1]) > APART_DEG));
}

/** One key's geometries from the first source that has them: an exact name first, then "<name> A.H.".
 * A name shared by places far apart is ambiguous and is not guessed between. */
function lookup(key, sources) {
  for (const { label, index } of sources) {
    const exact = index.get(key);
    if (exact) return scattered(exact) ? null : { label, geometries: exact };
  }
  for (const { label, index } of sources) {
    const hits = [...index.keys()].filter((k) => k.replace(HOLDINGS, '') === key && k !== key);
    if (hits.length === 1 && !scattered(index.get(hits[0]))) return { label, geometries: index.get(hits[0]) };
  }
  return null;
}

/** Polygons and MultiPolygons as one MultiPolygon (or the single Polygon when there is only one). */
export function combine(geometries) {
  const polygons = geometries.flatMap((g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []));
  if (!polygons.length) return null;
  return polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
}

/**
 * The outline for a suburb name, from `sources` in order of preference ([{ label, index }]).
 * Every part of a compound name must be found, or there is no match: half an outline would misstate the area.
 * Returns { boundary, sources: [label per part] } or null.
 */
export function matchBoundary(name, sources) {
  const found = nameParts(name).map((part) => lookup(part, sources));
  if (found.some((f) => !f)) return null;
  const boundary = combine(found.flatMap((f) => f.geometries));
  return boundary ? { boundary, sources: [...new Set(found.map((f) => f.label))] } : null;
}

/** The stored outline with the official piece added, unless the stored one already covers it. A stored outline often
 * includes a suburb's extensions on purpose (Fourways + Fourways Ext N), so the official outline for the bare name is
 * added to it, never swapped in: nothing that was drawn is lost. */
function withOfficial(stored, official) {
  if (!stored) return official;
  const inside = interiorPoint(official);
  return inside && geometryContains(stored, inside[0], inside[1]) ? stored : combine([stored, official]);
}

/**
 * A suburb whose dot is outside its own outline: which of the two is wrong, and the fix. `official` is
 * matchBoundary(name, sources) (the City's outline for exactly this name), or null.
 *   - dot inside the stored outline            -> { action: 'none' }
 *   - no official outline to judge by          -> { action: 'unsure' }  (never guess)
 *   - the official outline contains the dot    -> { action: 'outline', boundary }  (the stored outline was missing
 *     the main piece, e.g. President Park stitched from 1-ha extensions without the 708-ha "President Park A.H." around
 *     the dot): the official piece is added to the stored outline
 *   - it does not                              -> { action: 'dot', boundary, point }  (the geocoded dot was wrong,
 *     e.g. Lawley placed 32 km away): the dot moves inside the official outline, which is added if not yet covered
 */
export function planRepair({ boundary, lat, lon }, official) {
  if (boundary && geometryContains(boundary, lon, lat)) return { action: 'none' };
  if (!official) return { action: 'unsure' };
  const merged = withOfficial(boundary, official.boundary);
  // the official outline can overlap the stored one yet hold the dot in the part the stored one misses (North Riding):
  // the result must hold the dot too
  if (geometryContains(official.boundary, lon, lat)) return { action: 'outline', boundary: geometryContains(merged, lon, lat) ? merged : combine([boundary, official.boundary]) };
  const point = interiorPoint(official.boundary);
  return point ? { action: 'dot', boundary: merged, point } : { action: 'unsure' };
}
