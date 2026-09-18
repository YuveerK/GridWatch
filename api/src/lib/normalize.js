const TYPE_WORDS = /\b(substation|sub station|sub|switching station|switchgear|distributor|mini substation|mini sub|mss|kiosk|feeder|transformer|sdc)\b/g;

export function baseNormalize(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\bext(?:ension)?s?\s*/g, 'ext ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Key used to match an infrastructure name regardless of type words ("Peter Road Substation" ≈ "Peter Road"). */
export function infraKey(name) {
  return baseNormalize(name).replace(TYPE_WORDS, ' ').replace(/\s+/g, ' ').trim();
}

export function localityKey(name) {
  return baseNormalize(name);
}

/** Dice coefficient on character bigrams (0..1). */
export function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}
