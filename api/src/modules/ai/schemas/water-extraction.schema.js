import { z } from 'zod';

export const WATER_ENTITY_TYPES = ['WATER_SYSTEM', 'RESERVOIR', 'WATER_TOWER', 'PUMP_STATION', 'DIRECT_FEED', 'BULK_CONNECTION', 'BULK_METER', 'BOOSTER_STATION', 'TREATMENT_WORKS', 'PRV', 'WATER_PIPELINE', 'WATER_OTHER'];
export const WATER_OPERATORS = ['JOHANNESBURG_WATER', 'RAND_WATER', 'UNKNOWN'];
export const WATER_RELATIONS = ['SUPPLIES', 'PUMPS_TO', 'DIRECTLY_SUPPLIES', 'PART_OF', 'UPSTREAM_OF', 'BYPASSES', 'BACKFEEDS'];
export const WATER_STATES = ['NORMAL', 'STABLE', 'CONSTRAINED', 'LOW', 'CRITICAL', 'EMPTY', 'NO_INCOMING_SUPPLY', 'NO_PUMPING', 'PUMPING_REDUCED', 'OUTLET_CLOSED', 'PARTIAL_SUPPLY', 'LOW_PRESSURE', 'NO_SUPPLY', 'BYPASS', 'THROTTLED', 'RECOVERING', 'UNKNOWN'];
export const WATER_IMPACTS = ['NO_SUPPLY', 'LOW_PRESSURE', 'AFFECTED', 'RESTORED', 'UNKNOWN'];

const entityType = z.enum(WATER_ENTITY_TYPES);
const relation = z.enum(WATER_RELATIONS);
const waterState = z.enum(WATER_STATES);
const impact = z.enum(WATER_IMPACTS);
const operator = z.enum(WATER_OPERATORS).nullable();

const entity = z.object({
  type: entityType,
  name: z.string(),
  operator,
  parent_name: z.string().nullable().describe('Null unless the notice explicitly says this asset is fed by another named asset.'),
  relationType: relation.nullable().describe('Null unless parent_name is set. Do not invent a relationship.'),
});

const locality = z.object({
  name: z.string(),
  impact,
});

const fault = z.object({
  water_state: waterState,
  cause: z.string().nullable(),
  eta_text: z.string().nullable(),
  restoration_percent: z.number().nullable(),
  summary: z.string().nullable(),
  entities: z.array(entity).describe('Assets for this fault only. Empty array when none are named. Never an empty object.'),
  localities: z.array(locality).describe('Suburbs for this fault only. Empty array when none are named. Never an empty object.'),
  systems: z.array(z.string()),
});

export const waterExtractionSchema = z.object({
  relevance: z.enum(['INTERRUPTION', 'PLANNED_MAINTENANCE', 'SYSTEM_UPDATE', 'RESTORATION', 'INFORMATIONAL', 'IRRELEVANT']),
  kind: z.enum(['UNPLANNED', 'PLANNED']),
  water_state: waterState,
  customer_supply: z.enum(['RESTORED', 'PARTIAL']).nullable(),
  cause: z.string().nullable(),
  eta_text: z.string().nullable(),
  restoration_percent: z.number().nullable(),
  systems: z.array(z.string()),
  entities: z.array(entity).describe('Named water assets. Empty array when the notice names none. Never [{}].'),
  localities: z.array(locality).describe('Named suburbs. impact is the customer effect. Empty array when none are named.'),
  faults: z.array(fault).describe('One item per distinct system or asset condition in a multi-system bulletin. Empty when the notice is a single incident.'),
  image_text: z.string(),
  confidence: z.number(),
  review_reason: z.string().nullable(),
});

export const waterExtractionJsonSchema = z.toJSONSchema(waterExtractionSchema);
delete waterExtractionJsonSchema.$schema;

const OPERATOR_LABELS = {
  'johannesburg water': 'JOHANNESBURG_WATER',
  johannesburgwater: 'JOHANNESBURG_WATER',
  'joburg water': 'JOHANNESBURG_WATER',
  jw: 'JOHANNESBURG_WATER',
  'rand water': 'RAND_WATER',
  randwater: 'RAND_WATER',
};

function canonicalOperator(value) {
  if (value == null || WATER_OPERATORS.includes(value)) return value ?? null;
  const mapped = OPERATOR_LABELS[String(value).trim().toLowerCase()];
  return mapped ?? value;
}

function withoutEmpty(items) {
  return (items ?? []).filter((item) => item && typeof item === 'object' && Object.keys(item).length > 0).map((item) => ({ ...item, operator: canonicalOperator(item.operator) }));
}

/** Drop placeholder {} children and map the known operator labels. Unknown strings are left for Zod to reject. */
export function prepareWaterReading(raw) {
  const entities = withoutEmpty(raw.entities);
  const localities = (raw.localities ?? []).filter((item) => item && Object.keys(item).length > 0);
  const faults = (raw.faults ?? []).map((fault) => ({
    ...fault,
    entities: withoutEmpty(fault.entities),
    localities: (fault.localities ?? []).filter((item) => item && Object.keys(item).length > 0),
  }));
  return { ...raw, entities, localities, faults };
}
