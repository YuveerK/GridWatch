import { z } from 'zod';

export const RELEVANCE = ['OUTAGE', 'PLANNED_OUTAGE', 'RESTORATION', 'UPDATE', 'SDC_SUMMARY', 'GENERAL_NOTICE', 'IRRELEVANT'];
export const ENTITY_TYPES = ['SDC', 'SUBSTATION', 'DISTRIBUTOR', 'MINI_SUBSTATION', 'FEEDER', 'SWITCHING_STATION', 'KIOSK', 'TRANSFORMER', 'CABLE', 'LINE', 'OTHER'];
export const STATUSES = ['INVESTIGATING', 'CREW_DISPATCHED', 'REPAIRING', 'PARTIALLY_RESTORED', 'RESTORED', 'PLANNED', 'CANCELLED', 'UNKNOWN'];

const entitySchema = z.object({
  type: z.enum(ENTITY_TYPES),
  name: z.string().describe('Name as written, without the type word, e.g. "Peter Road" for "Peter Road Substation".'),
  parent_name: z.string().nullable().describe('Name of the entity this one is fed from, ONLY if the post states it (e.g. "Ruimsig Switching Station, Clover Rd Distributor": distributor parent = Ruimsig).'),
});

const localitySchema = z.object({ name: z.string(), state: z.enum(['AFFECTED', 'RESTORED', 'UNKNOWN']) });

export const extractionSchema = z.object({
  relevance: z.enum(RELEVANCE).describe('What kind of post this is. SDC_SUMMARY = periodic SDC-wide status graphic (open-call counts, constrained-system warning) that is not about one specific outage. IRRELEVANT/GENERAL_NOTICE for awareness, events, tips, theft campaigns, tariffs.'),
  sdc: z.string().nullable().describe('Service Delivery Centre from the hashtag, e.g. "Roodepoort" for #RoodepoortSDC.'),
  status: z.enum(STATUSES),
  cause: z.string().nullable().describe('Stated cause, e.g. "cable theft", "overhead line fault", "trees on line".'),
  eta_text: z.string().nullable().describe('Restoration estimate exactly as written, if any.'),
  restoration_percent: z.number().int().min(0).max(100).nullable(),
  entities: z.array(z.object({
    type: z.enum(ENTITY_TYPES),
    name: z.string().describe('Name as written, without the type word, e.g. "Peter Road" for "Peter Road Substation".'),
    parent_name: z.string().nullable().describe('Name of the entity this one is fed from, ONLY if the post states it (e.g. "Ruimsig Switching Station, Clover Rd Distributor": distributor parent = Ruimsig).'),
  })).describe('Every named piece of City Power infrastructure, in text or image.'),
  localities: z.array(z.object({
    name: z.string(),
    state: z.enum(['AFFECTED', 'RESTORED', 'UNKNOWN']),
  })).describe('Suburbs/areas named as affected or restored, in text or image.'),
  faults: z
    .array(
      z.object({
        status: z.enum(STATUSES),
        cause: z.string().nullable(),
        eta_text: z.string().nullable(),
        restoration_percent: z.number().int().min(0).max(100).nullable(),
        equipment: z.array(entitySchema).describe('Only the equipment of THIS fault.'),
        localities: z.array(localitySchema).describe('Only the suburbs of THIS fault.'),
      }),
    )
    .describe('ONLY when the post or its graphic reports SEVERAL separate faults (typical SDC "outage update" graphics listing each active outage in its own section): one item per separate fault. Empty array when the post is about a single fault.'),
  image_text: z.string().nullable().describe('Verbatim transcription of text visible in the attached images, preserving row/column structure. Maximum 3000 characters; stop there for very long lists. Null if no images or no text.'),
  confidence: z.number().min(0).max(1),
  review_reason: z.string().nullable().describe('Why a human should double check, else null.'),
});

export const extractionJsonSchema = z.toJSONSchema(extractionSchema);
delete extractionJsonSchema.$schema;
