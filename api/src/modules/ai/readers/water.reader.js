import { WATER_PROMPT_VERSION, buildWaterSystemPrompt, buildWaterUserText } from '../prompts/water.prompt.js';
import { prepareWaterReading, waterExtractionJsonSchema, waterExtractionSchema } from '../schemas/water-extraction.schema.js';

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

function usableSentence(text) {
  const sentence = typeof text === 'string' ? text.trim() : '';
  return sentence.length >= 25 ? sentence : '';
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
  const explicit = usableSentence(fault?.summary) || usableSentence(scope.cause) || usableSentence(result?.cause) || (!fault ? usableSentence(result?.update_summary) : '');
  if (explicit) return explicit;
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

/**
 * A status board names many assets and does not say they failed together.
 * A supply zone (many suburbs, one or two assets) and an explicit upstream link stay one incident.
 * A reading that already lists separate faults is left for the fault splitter.
 */
export function isUnsplitWaterBoard(result) {
  if (!result || (result.faults ?? []).length >= 2) return false;
  const assets = (result.entities ?? []).filter((e) => ZONE_ASSET.has(e.type));
  const names = new Set(assets.map((e) => e.name).filter(Boolean));
  if (names.size < 3) return false;
  if ((result.localities ?? []).length >= 5) return false;
  const systemNames = new Set(assets.filter((e) => e.type === 'WATER_SYSTEM').map((e) => e.name));
  const fedBySomethingElse = assets.some((e) => e.parent_name && !systemNames.has(e.parent_name));
  if (fedBySomethingElse) return false;
  return true;
}

export function waterFaultItems(extraction) {
  const faults = extraction.result?.faults ?? [];
  if (faults.length < 2) return [{ faultIndex: 0, extraction, fromDigest: false }];
  return faults.map((f, faultIndex) => ({
    faultIndex,
    fromDigest: true,
    extraction: {
      ...extraction,
      relevance: RELEVANCE[extraction.result.relevance] ?? extraction.relevance,
      result: asPipeline({ ...extraction.result, ...f, faults: [] }),
    },
  }));
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
