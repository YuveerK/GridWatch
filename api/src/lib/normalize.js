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

/** "12th Avenue in Parktown North" -> "Parktown North" (the place after "in"), or null when there is no such tail. */
export function tailPlace(name) {
  const m = /\s+in\s+([A-Za-z][A-Za-z .'-]{2,})$/i.exec(String(name ?? '').trim());
  return m ? m[1].trim() : null;
}

const STREET_WORDS = /\b(street|st|str|road|rd|avenue|ave|drive|dr|lane|ln|close|crescent|cres|boulevard|way|highway|between)\b/i;
const FACILITY_WORDS = /\b(centre|center|clinic|hospital|school|college|university|campus|stadium|mall|shopping|station|hotel|police|laboratory|wastewater|treatment|golf|shooting range|old age|church|mosque|water|standby|feederboard|substation|transformer|kiosk)\b/i;
const ORG_WORDS = /\b(transnet|eskom|absa|sabc|standard bank|nedbank|fnb|coca-?cola|rand daily mail|city power|johannesburg water|telkom)\b/i;

/** True for streets, facilities and companies that City Power lists next to real suburbs. */
export function isNotSuburbName(name) {
  const n = String(name ?? '').trim();
  return n.length < 3 || /^\d/.test(n) || /[,/&]/.test(n) || /\b(to|and|parts? of|surrounding|ward)\b/i.test(n) || /\s\d{3,}$/.test(n) || STREET_WORDS.test(n) || FACILITY_WORDS.test(n) || ORG_WORDS.test(n);
}

/**
 * Two equipment names that are almost certainly the same name misspelled: one letter off ("Klipfotein" / "Klipfontein"), or the
 * same letters scrambled with the same first and last letter ("Karzene" / "Kazerne"). Only for names of 7+ letters: short names
 * ("Fort", "Ridge") are too easily different places.
 */
export function likelyTypo(a, b) {
  if (a === b || Math.min(a.length, b.length) < 7) return false;
  if (a[0] !== b[0]) return false;
  if (oneEditApart(a, b)) return true;
  const letters = (s) => [...s.replace(/\s+/g, '')].sort().join('');
  return a.length === b.length && a.at(-1) === b.at(-1) && letters(a) === letters(b);
}

/** True when two names differ by exactly one inserted, deleted, changed or swapped letter ("Develand" / "Devland"). */
export function oneEditApart(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 1) return true;
    return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]; // two neighbouring letters swapped
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  return short.slice(i) === long.slice(i + 1);
}
