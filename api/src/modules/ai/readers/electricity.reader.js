import { buildSystemPrompt, buildUserText } from '../prompt.js';
import { extractionJsonSchema, extractionSchema } from '../extraction.schema.js';
import { parseSchedule, parseTimes } from '../../../lib/schedule.js';

const STATION = new Set(['SUBSTATION', 'SWITCHING_STATION']);

/**
 * A planned load-reduction table is one window applied to each named substation (Pretoria East, 30 Sept 06:00-12:00),
 * not one digest and not one umbrella outage. Null when the reading is not that table.
 */
export function loadReductionFaults(result) {
  const text = `${result?.image_text ?? ''}\n${result?.update_summary ?? ''}`;
  if (!/planned load reduction/i.test(text) || (result?.faults ?? []).length >= 2) return null;
  const stations = (result?.entities ?? []).filter((entity) => STATION.has(entity.type));
  if (stations.length < 2) return null;
  const sch = parseSchedule(text);
  // The fault's own sentence has to carry a date parseSchedule can read. An ISO day ("2026-09-30") is not one.
  const spoken = sch ? sch.date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, y, m, d) => `${Number(d)} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(m) - 1]} ${y}`) : '';
  const when = spoken ? `on ${spoken}${sch.from && sch.to ? ` from ${sch.from} to ${sch.to}` : ''}` : '';
  return stations.map((station) => ({
    status: 'PLANNED',
    cause: 'planned load reduction',
    eta_text: when,
    summary: `Planned load reduction at ${station.name}${when ? ` ${when}` : ''}.`,
    equipment: [{ type: station.type, name: station.name, parent_name: null }],
    localities: [],
  }));
}

/** Combine compatible rows for one station, preserving distinct lifecycle states and scheduled windows. */
export function mergeSameStationFaults(faults, { indexed = false } = {}) {
  const groups = new Map();
  const other = [];
  const sources = (faults ?? []).map((fault, sourceFaultIndex) => indexed ? { ...fault, sourceFaultIndex } : fault);
  for (const fault of sources) {
    const gear = (fault.equipment ?? []).filter((entity) => entity.type !== 'SDC');
    const stations = gear.filter((entity) => STATION.has(entity.type));
    if (gear.length !== 1 || stations.length !== 1) {
      other.push(fault);
      continue;
    }
    const text = `${fault.summary ?? ''} ${fault.eta_text ?? ''}`;
    const schedule = parseSchedule(text);
    const times = schedule ?? parseTimes(text);
    const key = JSON.stringify([stations[0].type, stations[0].name.toLowerCase(), fault.status]);
    const window = { date: schedule?.date, endDate: schedule?.endDate ?? schedule?.date, from: times?.from, to: times?.to };
    const buckets = groups.get(key) ?? [];
    // A missing/truncated time is not a different window. Split only when both
    // rows state conflicting values; compare every row to avoid an undated row
    // bridging two explicitly different dates.
    let bucket = buckets.find((b) => b.windows.every((w) => Object.keys(window).every((k) => !w[k] || !window[k] || w[k] === window[k])));
    if (!bucket) { bucket = { faults: [], windows: [] }; buckets.push(bucket); }
    bucket.faults.push(fault);
    bucket.windows.push(window);
    groups.set(key, buckets);
  }
  const merged = [];
  for (const list of [...groups.values()].flatMap((buckets) => buckets.map((b) => b.faults))) {
    if (list.length === 1) {
      merged.push(list[0]);
      continue;
    }
    const [first] = list;
    const localities = [];
    for (const fault of list) for (const place of fault.localities ?? []) if (!localities.some((have) => have.name === place.name)) localities.push(place);
    merged.push({
      ...first,
      localities,
      summary: list.map((fault) => fault.summary).filter(Boolean).join(' '),
      cause: list.map((fault) => fault.cause).filter(Boolean).join(' '),
    });
  }
  const result = [...merged, ...other];
  return indexed ? result.sort((a, b) => a.sourceFaultIndex - b.sourceFaultIndex) : result;
}

export const electricityReader = {
  serviceType: 'ELECTRICITY',
  promptVersion: null,
  buildSystemPrompt,
  buildUserText,
  jsonSchema: extractionJsonSchema,
  zodSchema: extractionSchema,
  normaliseReading: (reading) => reading,
};
