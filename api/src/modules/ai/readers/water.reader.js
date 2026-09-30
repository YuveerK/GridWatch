import { WATER_PROMPT_VERSION, buildWaterSystemPrompt, buildWaterUserText } from '../prompts/water.prompt.js';
import { prepareWaterReading, waterExtractionJsonSchema, waterExtractionSchema } from '../schemas/water-extraction.schema.js';
import { namedAfter } from '../../../lib/normalize.js';

const RELEVANCE = {
  INTERRUPTION: 'OUTAGE',
  PLANNED_MAINTENANCE: 'PLANNED_OUTAGE',
  SYSTEM_UPDATE: 'UPDATE',
  RESTORATION: 'RESTORATION',
  INFORMATIONAL: 'GENERAL_NOTICE',
  IRRELEVANT: 'IRRELEVANT',
};

const STATUS = { OUTAGE: 'INVESTIGATING', PLANNED_OUTAGE: 'PLANNED', RESTORATION: 'RESTORED', UPDATE: 'INVESTIGATING', GENERAL_NOTICE: 'INVESTIGATING', IRRELEVANT: 'INVESTIGATING' };

const INCIDENT_RELEVANCE = new Set(['INTERRUPTION', 'OUTAGE', 'PLANNED_MAINTENANCE', 'PLANNED_OUTAGE', 'RESTORATION', 'SYSTEM_UPDATE', 'UPDATE']);
const QUIET_STATE = new Set(['UNKNOWN', 'NORMAL', 'STABLE']);
const NON_OPERATIONAL = /trivia|quiz|riddle|hiring|recruit|advertisement|promotional|community post|awareness campaign|rather than an operational|not an operational/i;
const HEADLINE_ONLY = /system update|only a link|without specific operational|no specific operational|no actionable|headline only/i;

function hasIncidentFacts(result) {
  const cause = (result?.cause ?? '').trim();
  const state = result?.water_state;
  return (result?.entities ?? []).length > 0
    || (result?.localities ?? []).length > 0
    || (result?.faults ?? []).length > 0
    || cause.length > 0
    || result?.customer_supply != null
    || (state != null && !QUIET_STATE.has(state));
}

/**
 * A fact-free water notice a person cannot turn into an incident.
 * IRRELEVANT: trivia, promotion, community content.
 * GENERAL_NOTICE: an operational headline or link with no asset, suburb or supply state.
 * null: leave the reading alone, including a low-confidence outage a person might still resolve.
 */
export function classifyWaterNotice(result, text = '') {
  if (!result || hasIncidentFacts(result)) return null;
  const reason = result.review_reason ?? '';
  const blob = `${text}\n${result.image_text ?? ''}\n${reason}`;
  const nonOperational = NON_OPERATIONAL.test(blob);
  const headline = HEADLINE_ONLY.test(blob);
  if (INCIDENT_RELEVANCE.has(result.relevance) && !nonOperational && !headline) return null;
  if (nonOperational && !(headline && !NON_OPERATIONAL.test(`${text}\n${reason}`))) return 'IRRELEVANT';
  if (headline || result.relevance === 'INFORMATIONAL' || result.relevance === 'GENERAL_NOTICE') return headline || /link|without specific|no specific/i.test(reason) ? 'GENERAL_NOTICE' : null;
  if (result.relevance === 'IRRELEVANT') return 'IRRELEVANT';
  return null;
}

function withLocalityState(localities) {
  return (localities ?? []).map((l) => ({
    name: l.name,
    state: l.impact === 'RESTORED' ? 'RESTORED' : 'AFFECTED',
    impact: l.impact ?? 'UNKNOWN',
  }));
}

const MAX_SUMMARY = 260;

function usableSentence(text) {
  const sentence = typeof text === 'string' ? text.trim() : '';
  // A pasted status-board paragraph is not a resident sentence. Compose one from the assets instead.
  return sentence.length >= 25 && sentence.length <= MAX_SUMMARY ? sentence : '';
}

function joinNames(items) {
  const names = [...new Set((items ?? []).map((item) => item?.name).filter(Boolean))].slice(0, 3);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * A resident sentence for a water notice. An explicit sentence already on the reading is kept.
 * Customer restoration is stated only when the reading says supply was restored.
 * Recovery, low pressure and no supply stay in their own words.
 */
export function waterNoticeSummary(result, fault = null) {
  const scope = fault ?? result ?? {};
  const overflow = [fault?.summary, scope.cause, result?.cause].some((text) => typeof text === 'string' && text.trim().length > MAX_SUMMARY);
  // A pasted paragraph is not the resident sentence. Name the assets and the operating state instead.
  if (!overflow) {
    const explicit = usableSentence(fault?.summary) || usableSentence(scope.cause) || usableSentence(result?.cause) || (!fault ? usableSentence(result?.update_summary) : '');
    if (explicit) return explicit;
  }
  const entities = scope.entities?.length ? scope.entities : result?.entities;
  const localities = scope.localities?.length ? scope.localities : result?.localities;
  const asset = joinNames(entities);
  const place = joinNames(localities);
  const supply = scope.customer_supply ?? result?.customer_supply;
  const state = scope.water_state ?? result?.water_state;
  const where = place ? ` in ${place}` : '';
  const at = asset ? ` at ${asset}` : '';
  const subject = asset || 'The water network';
  if (supply === 'RESTORED') return `Water supply has been restored${at}${where}.`;
  if (state === 'RECOVERING') return `${subject} is recovering${where}. Customers are not yet confirmed to have water.`;
  if (supply === 'PARTIAL' || state === 'PARTIAL_SUPPLY') return `Water supply is only partial${at}${where}.`;
  if (state === 'LOW_PRESSURE' || state === 'LOW') return `${subject}${where} is supplying at low pressure.`;
  if (state === 'NO_SUPPLY' || state === 'EMPTY' || state === 'NO_INCOMING_SUPPLY' || state === 'NO_PUMPING') return `${subject}${where} has no water supply.`;
  const cause = (scope.cause || result?.cause || '').trim();
  if (cause) return `${subject}${where}: ${cause}.`;
  return `${subject}${where} has a water supply update.`.replace('  ', ' ');
}

function asPipeline(result) {
  const relevance = classifyWaterNotice(result) ?? RELEVANCE[result.relevance] ?? result.relevance;
  return {
    ...result,
    relevance,
    status: result.water_state === 'RECOVERING' ? 'INVESTIGATING' : result.customer_supply === 'RESTORED' || result.water_state === 'NORMAL' ? 'RESTORED' : result.customer_supply === 'PARTIAL' ? 'PARTIALLY_RESTORED' : STATUS[relevance] ?? 'INVESTIGATING',
    sdc: null,
    entities: result.entities ?? [],
    localities: withLocalityState(result.localities),
    faults: (result.faults ?? []).map((fault) => ({ ...fault, localities: withLocalityState(fault.localities) })),
    update_summary: waterNoticeSummary(result),
  };
}

const ZONE_ASSET = new Set(['RESERVOIR', 'WATER_TOWER', 'PUMP_STATION', 'WATER_SYSTEM', 'DIRECT_FEED', 'BOOSTER_STATION', 'TREATMENT_WORKS']);

// ── Johannesburg Water's daily "SYSTEM UPDATES ... <System> System Reservoir/ Tower Status" boards ─────────────────────────
// About eight a round, twice a day, always "<Asset> <status sentence>" per reservoir, tower or pump station. The AI read the
// same board as 16 faults one time, one unsplit notice the next and a general notice the time after, so incidents came and
// went with the reading. The board is split here, in code, from the text the reader transcribed: every read of the same
// board gives the same faults, and stored readings can be re-linked without reading them again.

// "Reservoir/ Tower Status" heads the board; a transcription sometimes drops "Status" (Soweto, 25 Sept 13:15)
const BOARD = /Reservoir\s*\/\s*Tower(?:\s+Status)?/i;
const ASSET = /((?:[A-Z0-9][\w'’&-]*\s+){0,5}?(?:Reservoir|Res|Tower|Pump\s?Station|Direct Feeds?))(?=[\s.,;:]|$)/g;
// words that open a status sentence, never an asset name ("Supplying fairly. Declining Ennerdale Reservoir")
const STATUS_WORD = /^(?:Supplying|Declining|Improving|Normal|Overnight|Outlet|No|On|Low|Poor|Critically|Recovering|Throttling)\s+/;
const TYPE_OF = [[/pump\s?station$/i, 'PUMP_STATION'], [/direct feeds?$/i, 'DIRECT_FEED'], [/tower$/i, 'WATER_TOWER'], [/(reservoir|res)$/i, 'RESERVOIR']];

/**
 * What one board line says, and whether customers face a problem worth an incident. Plain "supplying fairly" is the board's
 * own middle band (most assets, most days): not an incident on its own. On bypass while supplying adequately is not either.
 */
export function boardState(text) {
  const t = text.toLowerCase();
  if (/no pumping/.test(t)) return { state: 'NO_PUMPING', problem: true };
  if (/outlet(s)? closed/.test(t)) return { state: 'OUTLET_CLOSED', problem: true };
  if (/critically low/.test(t)) return { state: 'CRITICAL', problem: true };
  if (/\bempty\b/.test(t)) return { state: 'EMPTY', problem: true };
  if (/(poor|low)\s+pressure|no water|pressure may occur/.test(t)) return { state: 'LOW_PRESSURE', problem: true };
  if (/\blow\b/.test(t)) return { state: 'LOW', problem: true };
  if (/overnight closure|throttl/.test(t)) return { state: 'THROTTLED', problem: true };
  if (/on bypass/.test(t)) return /adequate/.test(t) ? { state: 'BYPASS', problem: false } : { state: 'BYPASS', problem: true };
  if (/improving|recover/.test(t)) return { state: 'RECOVERING', problem: false };
  if (/adequate|normal pumping|normally/.test(t)) return { state: 'NORMAL', problem: false };
  if (/fair|failry|declining/.test(t)) return { state: 'CONSTRAINED', problem: false };
  return { state: 'UNKNOWN', problem: false };
}

/** A deliberate closure (demand management, overnight closure, throttling), not a fault: it may belong to an announced planned job. */
export const deliberateClosure = (text) => /overnight|demand management|throttl|scheduled|planned/i.test(text ?? '');

/** { system, assets: [{ name, type, text, state, problem }] } for a status board's text, or null when it is not one. */
export function parseStatusBoard(imageText) {
  const text = String(imageText ?? '').replace(/\s+/g, ' ');
  const at = text.search(BOARD);
  let system = null;
  let body = null;
  if (at >= 0) {
    system = (text.slice(0, at).match(/([A-Z][\w ]*?)\s+System\s*$/) ?? [])[1]?.trim() ?? null;
    body = text.slice(at).replace(BOARD, '').split(/\bIndicators\b/i)[0];
  } else if (!/customer notice/i.test(text) && (text.match(/supplying (adequately|fairly|failry)|on bypass|critically low|no pumping|outlet closed/gi) ?? []).length >= 3) {
    // The evening board sometimes drops the "Reservoir/ Tower Status" heading (Midrand, 29 Sept 20:55) and starts at the assets.
    // The asset pattern also swallows a clock time ("20:55 Midrand System Erand Reservoir"), so the system name is the anchor.
    const named = text.match(/\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s+System\b/);
    if (!named) return null;
    const after = text.slice(named.index + named[0].length);
    const firstAsset = after.search(new RegExp(ASSET.source));
    if (firstAsset < 0) return null;
    system = named[1].trim();
    body = after.slice(firstAsset).split(/\bIndicators\b/i)[0];
  }
  if (body == null) return null;
  const hits = [];
  for (const m of body.matchAll(ASSET)) {
    let name = m[1].trim();
    let start = m.index;
    for (let lead = name.match(STATUS_WORD); lead && name.length > lead[0].length; lead = name.match(STATUS_WORD)) {
      name = name.slice(lead[0].length);
      start += lead[0].length;
    }
    hits.push({ name: name.replace(/\bRes$/, 'Reservoir'), start, end: m.index + m[0].length });
  }
  const assets = hits.map((h, i) => {
    const line = body.slice(h.end, hits[i + 1]?.start ?? body.length).trim().replace(/^[.,;:\s]+/, '');
    return { name: h.name, type: TYPE_OF.find(([re]) => re.test(h.name))?.[1] ?? 'WATER_OTHER', text: line, ...boardState(line) };
  });
  return assets.length ? { system, assets } : null;
}

const assetStem = (name) => name.replace(/\s+(reservoir|tower)$/i, '').trim().toLowerCase();

/** A reservoir and its tower on the same board are one place (Witpoortjie Reservoir outlet closed, Witpoortjie Tower not pumping, 29 Sept). */
function mergeReservoirAndTower(faults) {
  const groups = new Map();
  const other = [];
  for (const fault of faults) {
    const entity = fault.entities?.length === 1 ? fault.entities[0] : null;
    if (!entity || (entity.type !== 'RESERVOIR' && entity.type !== 'WATER_TOWER')) {
      other.push(fault);
      continue;
    }
    const list = groups.get(assetStem(entity.name)) ?? [];
    list.push(fault);
    groups.set(assetStem(entity.name), list);
  }
  const merged = [];
  for (const list of groups.values()) {
    const types = new Set(list.map((fault) => fault.entities[0].type));
    if (list.length === 2 && types.has('RESERVOIR') && types.has('WATER_TOWER')) {
      const [reservoir, tower] = list[0].entities[0].type === 'RESERVOIR' ? list : [list[1], list[0]];
      merged.push({
        ...reservoir,
        entities: [reservoir.entities[0], tower.entities[0]],
        cause: [reservoir.cause, tower.cause].filter(Boolean).join(' '),
        summary: [reservoir.summary, tower.summary].filter(Boolean).join(' '),
        planned_closure: Boolean(reservoir.planned_closure || tower.planned_closure),
      });
    } else merged.push(...list);
  }
  return [...merged, ...other];
}

/** The board's problem assets as faults (one each), or null when the reading is not a status board. */
export function statusBoardFaults(result) {
  const board = parseStatusBoard(result?.image_text);
  if (!board) return null;
  const faults = board.assets.filter((a) => a.problem).map((a) => ({
    water_state: a.state,
    cause: a.text || null,
    eta_text: null,
    restoration_percent: null,
    summary: `${a.name}: ${a.text}`.replace(/\.?$/, '.'),
    entities: [{ type: a.type, name: a.name, operator: 'JOHANNESBURG_WATER', parent_name: null, relationType: null }],
    localities: [],
    systems: board.system ? [board.system] : [],
    planned_closure: deliberateClosure(a.text), // may join the announced planned job for this asset (scoreWaterCandidate)
  }));
  return mergeReservoirAndTower(faults);
}

/**
 * Johannesburg Water's daily "Management of Systems" notice: the reservoirs whose supply is throttled or closed tonight
 * (roughly 18:00 to 05:00), every day. It is a standing schedule, not an incident: the same closures reach the map through
 * the evening status boards ("Overnight closure"). Read inconsistently it opened a few incidents some days and none on
 * others, so it is always a notice. Narrow on purpose: it must say "Management of Systems" and throttling, and its "suburbs"
 * must be (mostly) the assets' own names echoed back ("Lenasia" from "Lenasia High Level Reservoir"). A notice naming real
 * affected suburbs is handled as usual.
 */
export function isThrottlingSchedule(result) {
  const text = String(result?.image_text ?? '');
  if (!/management\s*of\s*systems/i.test(text) || !/throttl/i.test(text)) return false;
  const parts = [result, ...(result.faults ?? [])];
  const assets = parts.flatMap((p) => p.entities ?? []).map((e) => e.name).filter(Boolean);
  const places = parts.flatMap((p) => p.localities ?? []).map((l) => l.name).filter(Boolean);
  // mostly echoes: the one left over is an asset the reader dropped (11 Sept: "President Park" without its outlet)
  const echoes = places.filter((place) => assets.some((asset) => namedAfter(asset, place))).length;
  return echoes * 2 > places.length || places.length === 0;
}

/** Reads like a status board's list: several "supplying adequately/fairly", "on bypass", "critically low" lines. */
export const statusListLike = (text) => (String(text ?? '').match(/supplying (adequately|fairly|failry)|on bypass|critically low/gi) ?? []).length >= 3;

const asNotice = (extraction) => [{ faultIndex: 0, fromDigest: false, extraction: { ...extraction, relevance: 'GENERAL_NOTICE', result: { ...extraction.result, relevance: 'GENERAL_NOTICE', faults: [] } } }];

/**
 * A status board names many assets and does not say they failed together.
 * A supply zone (many suburbs, one or two assets) and an explicit upstream link stay one incident.
 * A reading that already lists separate faults is left for the fault splitter, and so is a board the code can split itself.
 */
export function isUnsplitWaterBoard(result) {
  if (!result || (result.faults ?? []).length >= 2) return false;
  if (statusBoardFaults(result) || isThrottlingSchedule(result)) return false;
  // Only a status LIST is a board: a written customer notice about one event that names several assets (the Commando notice
  // of 26 Sept: incoming supply lost, Crosby pumping to Brixton stopped, HH1/HH2 affected) is one incident, not a board.
  if (!statusListLike(result.image_text) || /customer notice/i.test(result.image_text ?? '')) return false;
  const assets = (result.entities ?? []).filter((e) => ZONE_ASSET.has(e.type));
  const names = new Set(assets.map((e) => e.name).filter(Boolean));
  if (names.size < 3) return false;
  if ((result.localities ?? []).length >= 5) return false;
  const systemNames = new Set(assets.filter((e) => e.type === 'WATER_SYSTEM').map((e) => e.name));
  const fedBySomethingElse = assets.some((e) => e.parent_name && !systemNames.has(e.parent_name));
  if (fedBySomethingElse) return false;
  return true;
}

const ZONE_SPLIT = new Set(['RESERVOIR', 'WATER_TOWER', 'PUMP_STATION']);

/** Several assets of the same kind, with no water system tying them together, are separate incidents.
 * A reservoir and its tower stay one fault. */
function expandIndependentZoneAssets(fault) {
  const entities = fault.entities ?? [];
  if (entities.some((entity) => entity.type === 'WATER_SYSTEM')) return [fault];
  const zones = entities.filter((entity) => ZONE_SPLIT.has(entity.type));
  if (zones.length < 2) return [fault];
  const type = zones[0].type;
  if (zones.some((zone) => zone.type !== type)) return [fault];
  // Numbered units reported together with one condition remain the source's one
  // fault. Merely counting Hursthill 1 and 2 is not evidence of two incidents.
  const family = (name) => String(name).toLowerCase().replace(/\b(reservoir|tower|pump station)\b/g, '').replace(/\b\d+\b/g, '').replace(/\s+/g, ' ').trim();
  const families = new Set(zones.map((zone) => family(zone.name)));
  if (families.size === 1 && !families.has('')) return [fault];
  return zones.map((zone) => ({ ...fault, entities: [zone], systems: [] }));
}

export function waterFaultItems(extraction) {
  if (isThrottlingSchedule(extraction.result)) return asNotice(extraction);
  const board = statusBoardFaults(extraction.result);
  if (board) {
    // nothing on the board needs attention: the post is a notice
    if (!board.length) return asNotice(extraction);
    return board.map((f, faultIndex) => ({
      faultIndex,
      fromDigest: true,
      extraction: { ...extraction, relevance: 'UPDATE', result: asPipeline({ ...extraction.result, relevance: 'UPDATE', customer_supply: null, localities: [], ...f, faults: [] }) },
    }));
  }
  const faults = (extraction.result?.faults ?? []).flatMap(expandIndependentZoneAssets);
  if (faults.length < 2) return [{ faultIndex: 0, extraction, fromDigest: false }];
  return faults.map((f, faultIndex) => {
    // "Roodepoort systems remain stable and supplying fairly" names no asset and no suburb: it is not an incident.
    const notice = !(f.entities ?? []).length && !(f.localities ?? []).length && QUIET_STATE.has(f.water_state);
    return {
      faultIndex,
      fromDigest: true,
      extraction: {
        ...extraction,
        relevance: notice ? 'GENERAL_NOTICE' : (RELEVANCE[extraction.result.relevance] ?? extraction.relevance),
        result: asPipeline({ ...extraction.result, ...f, relevance: notice ? 'INFORMATIONAL' : extraction.result.relevance, faults: [] }),
      },
    };
  });
}

export const waterReader = {
  serviceType: 'WATER',
  promptVersion: WATER_PROMPT_VERSION,
  buildSystemPrompt: buildWaterSystemPrompt,
  buildUserText: buildWaterUserText,
  jsonSchema: waterExtractionJsonSchema,
  zodSchema: waterExtractionSchema,
  parse: (raw) => waterExtractionSchema.parse(prepareWaterReading(raw)),
  normaliseReading: (raw) => {
    const piped = asPipeline(raw);
    return { ...piped, __reading: raw.__reading };
  },
};
