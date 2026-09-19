import { baseNormalize } from './normalize.js';

const REGION_NAMES = { A: 'Region A', B: 'Region B', C: 'Region C', D: 'Region D', E: 'Region E', F: 'Region F', G: 'Region G' };

/**
 * Parse the human-maintained johannesburg.txt: "Region X" headings followed by suburbs, one per line or comma/period
 * separated paragraphs, plus Region E "WARD LOCATION" tables whose lines start with a ward number.
 * Returns [{ code, name, localities: [{ name, sourceLine }] }] with each suburb once per region.
 */
export function parseGeographyText(text) {
  const regions = [];
  let current = null;
  const lines = String(text).replace(/^﻿/, '').replace(/​/g, '').split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^region\s+([A-G])\b/i.exec(line);
    if (heading) {
      const code = heading[1].toUpperCase();
      current = { code, name: REGION_NAMES[code], localities: [], seen: new Set() };
      regions.push(current);
      continue;
    }
    if (!current || /^ward\s+location/i.test(line)) continue;
    const body = line.replace(/^\d{1,3}\s+(?=[A-Za-z])/, ''); // a ward number opening a Region E row
    const pieces = body.split(/,|(?<!\bExt)\.\s+(?=[A-Z])/i).map((p) => p.replace(/[.\s]+$/, '').replace(/^\s*and\s+/i, '').trim());
    for (const name of pieces) {
      const normalized = baseNormalize(name);
      // drop empties, bare extension numbers ("2", "3 4 5") and duplicates
      if (!normalized || /^[\d\s]+$/.test(normalized) || current.seen.has(normalized)) continue;
      current.seen.add(normalized);
      current.localities.push({ name, normalizedName: normalized, sourceLine: i + 1 });
    }
  }
  return regions.map(({ seen, ...r }) => r);
}

/** Names that appear in more than one region (kept in each, but worth a look). */
export function collisions(regions) {
  const where = new Map();
  for (const r of regions) for (const l of r.localities) where.set(l.normalizedName, [...(where.get(l.normalizedName) ?? []), r.code]);
  return [...where].filter(([, codes]) => codes.length > 1).map(([name, codes]) => ({ name, regions: codes }));
}
