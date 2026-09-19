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

/** True when two names differ only in a short (<=2 chars) or numeric token: those are different equipment, not typos. */
export function differsByLabel(a, b) {
  const ta = new Set(a.split(' '));
  const tb = new Set(b.split(' '));
  const odd = [...ta].filter((t) => !tb.has(t)).concat([...tb].filter((t) => !ta.has(t)));
  return odd.some((t) => t.length <= 2 || /\d/.test(t));
}

const STREET_WORDS = /\b(street|st|str|road|rd|avenue|ave|drive|dr|lane|ln|close|crescent|cres|boulevard|way|highway|between)\b/i;
const FACILITY_WORDS = /\b(centre|center|clinic|hospital|school|college|university|campus|stadium|mall|shopping|station|hotel|police|laboratory|wastewater|treatment|golf|shooting range|old age|church|mosque|water|standby|feederboard|substation|transformer|kiosk)\b/i;
const ORG_WORDS = /\b(transnet|eskom|absa|sabc|standard bank|nedbank|fnb|coca-?cola|rand daily mail|city power|johannesburg water|telkom)\b/i;

/** True for streets, facilities and companies that City Power lists next to real suburbs. */
export function isNotSuburbName(name) {
  const n = String(name ?? '').trim();
  return n.length < 3 || /^\d/.test(n) || /[,/&]/.test(n) || /\b(to|and|parts? of|surrounding|ward)\b/i.test(n) || /\s\d{3,}$/.test(n) || STREET_WORDS.test(n) || FACILITY_WORDS.test(n) || ORG_WORDS.test(n);
}
