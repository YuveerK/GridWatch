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

// A line/feeder label ("A", "D", "1B", "Line D", "Feeder 2") names nothing on its own: it is that line OF a station.
const LABEL = String.raw`([A-Za-z0-9]{1,2}|(?:no\.?\s*)?\d+[a-z]?)`;
const BARE_LABEL = new RegExp(String.raw`^(?:(?:line|feeder|cable|circuit)\s+)?${LABEL}$`, 'i');
const STATION_LINE = new RegExp(String.raw`^(.+?)\s+line\s+${LABEL}$`, 'i');

/**
 * The name an electrical label is stored under. "Line D" and "D" at Tshepisong are both "Tshepisong D", and so is
 * "Tshepisong Line D" (the same line had been stored twice, as "Tshepisong D" and "Tshepisong Line D"). A bare label with no
 * station to belong to is null: too vague to store ("Line C" alone would tie every station's line C together).
 * { name, bare } - bare is true when the station was supplied here (the caller records it as the parent).
 * Only a PART of a station (line, feeder, cable, circuit, distributor) is dropped for want of one: a substation "K3" or a
 * mini-substation "03962" is a site in its own right and keeps its name.
 */
const STATION_PARTS = new Set(['LINE', 'FEEDER', 'CABLE', 'CIRCUIT', 'DISTRIBUTOR']);
export function labelledEquipmentName(name, station, type = 'LINE', context = '') {
  let n = String(name ?? '').trim();
  // A site number the reader shortened: the notice says "TSS 65", the reading says "65". Taken back from the notice's own text,
  // so the same site keeps one name (26 Sept: "65" opened a second incident beside the running "TSS 65" one).
  if (!station && /^\d{1,4}[a-z]?$/i.test(n)) {
    const prefixed = String(context ?? '').match(new RegExp(String.raw`\b([A-Z]{2,5})\s*${n}\b`));
    if (prefixed) n = `${prefixed[1]} ${n}`;
  }
  const bare = n.match(BARE_LABEL);
  if (bare) return station ? { name: `${station} ${bare[1]}`, bare: true } : STATION_PARTS.has(type) ? null : { name: n, bare: false };
  const withLine = n.match(STATION_LINE);
  if (withLine) return { name: `${withLine[1]} ${withLine[2]}`, bare: false };
  return { name: n, bare: false };
}

/** "275kV", "132 kV", "33kV": a voltage class, not a piece of equipment. */
export const isBareVoltage = (name) => /^\d+(?:[.,]\d+)?\s*kv$/i.test(String(name ?? '').trim());

// Words that describe a water asset without identifying it: "burst water pipe", "affected pipeline", "400mm pipe".
const GENERIC_WATER_WORDS = new Set(['burst', 'water', 'pipe', 'pipes', 'pipeline', 'pipelines', 'line', 'main', 'mains', 'affected', 'the', 'a', 'an', 'network', 'reticulation', 'diameter', 'dia', 'mm', 'reservoir', 'outlet', 'inlet', 'station', 'prv', 'valve', 'leak', 'leaking', 'damaged', 'broken', 'supply', 'bulk']);

/** True when a water asset's name is only a description ("burst water pipe") and names no particular asset. Stored as one
 * node, such a description tied every burst in the city together; a named pipe ("Grosvenor Road", "HH2 interlink pipeline")
 * is kept. */
export function isGenericWaterAsset(name) {
  const words = baseNormalize(name).split(' ').filter(Boolean);
  return words.every((w) => GENERIC_WATER_WORDS.has(w) || /^\d+(mm)?$/.test(w));
}

/** True when an asset's name carries a place's name: "Orange Farm High Level Reservoir" (Orange Farm), "Brixton 1 Reservoir"
 * (Brixton), "PD line Schuverburg" (Schuverburg). Whole words only, so "Lenasia Reservoir" does not carry "Lenasia South",
 * and nothing carries "Len". */
export function namedAfter(assetName, placeName) {
  const place = localityKey(placeName);
  return place.length >= 3 && ` ${localityKey(assetName)} `.includes(` ${place} `);
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
const ORG_WORDS = /\b(transnet|eskom|absa|sabc|standard bank|nedbank|fnb|coca-?cola|rand daily mail|city power|johannesburg water|telkom|city of tshwane|tshwane)\b/i;

/** True for streets, facilities and companies that a utility lists next to real suburbs. */
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
