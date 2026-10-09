import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ENTITY_TYPES, RELEVANCE, STATUSES } from '../ai/extraction.schema.js';
import { WATER_ENTITY_TYPES, WATER_IMPACTS, WATER_OPERATORS, WATER_RELATIONS, WATER_STATES } from '../ai/schemas/water-extraction.schema.js';

export const json = (value) => JSON.parse(JSON.stringify(value));
const sorted = (value) => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
export const fingerprint = (value) => createHash('sha256').update(JSON.stringify(sorted(json(value)))).digest('hex');
// Media keys and layout identify the utility evidence. Delivery query parameters can change without new evidence.
export function sourceMediaHash(post) {
  const media = (post.PostMedia ?? []).map((m) => ({ key: m.mediaKey, type: m.mediaType, width: m.width ?? null, height: m.height ?? null,
    location: (() => { try { const u = new URL(m.url);return `${u.origin}${u.pathname}`; } catch { return m.url; } })() })).sort((a,b) => a.key.localeCompare(b.key));
  return fingerprint(media);
}
export const sourceHash = (post) => fingerprint({ service: post.serviceType, text: post.noteTweetText || post.text, publishedAt: post.publishedAt, media: sourceMediaHash(post) });
// Reproducible identifiers are reserved by the preview, then used by the fenced transaction.
export const identityId = (parts) => `review_${fingerprint(parts).slice(0, 32)}`;
export const caseId = (subjectKey) => `rc_${fingerprint(subjectKey).slice(0, 32)}`;
const name = z.string().trim().min(1).max(200);
const optionalText = z.string().trim().max(3000).nullable().default(null);
const core = {
  faultIndex: z.number().int().min(0).max(10000),
  relevance: z.enum(RELEVANCE.filter((r) => r !== 'SDC_SUMMARY')), status: z.enum(STATUSES),
  cause: optionalText, eta_text: optionalText,
  restoration_percent: z.number().int().min(0).max(100).nullable().default(null),
  summary: z.string().trim().max(1000).default(''),
};
const electricityFault = z.object({
  ...core,
  entities: z.array(z.object({ type: z.enum(ENTITY_TYPES), name, parent_name: name.nullable().default(null) }).strict()).max(100),
  localities: z.array(z.object({ name, state: z.enum(['AFFECTED', 'RESTORED', 'UNKNOWN']) }).strict()).max(200),
}).strict();
const waterFault = z.object({
  ...core,
  entities: z.array(z.object({ type: z.enum(WATER_ENTITY_TYPES), name, parent_name: name.nullable().default(null), operator: z.enum(WATER_OPERATORS).nullable().default(null), relationType: z.enum(WATER_RELATIONS).nullable().default(null) }).strict()).max(100),
  localities: z.array(z.object({ name, impact: z.enum(WATER_IMPACTS) }).strict()).max(200),
  water_state: z.enum(WATER_STATES), customer_supply: z.enum(['RESTORED', 'PARTIAL']).nullable().default(null),
  systems: z.array(name).max(50).default([]),
}).strict();
export const ManualReading = z.discriminatedUnion('serviceType', [
  z.object({ serviceType: z.literal('ELECTRICITY'), sdc: name.nullable().default(null), faults: z.array(electricityFault).min(1).max(100) }).strict(),
  z.object({ serviceType: z.literal('WATER'), faults: z.array(waterFault).min(1).max(100) }).strict(),
]).superRefine((reading, ctx) => {
  if (new Set(reading.faults.map((f) => f.faultIndex)).size !== reading.faults.length) ctx.addIssue({ code: 'custom', message: 'Each fault must have a distinct, stable number.', path: ['faults'] });
});
const evidence = z.object({ kind: z.enum(['TEXT', 'IMAGE']), quote: z.string().trim().min(3).max(3000), mediaKey: z.string().max(200).optional() }).strict();
const target = { faultIndex: z.number().int().min(0), targetOutageId: z.string().max(100).nullable().optional() };
export const Correction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('JOIN'), targetOutageId: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('SPLIT') }).strict(),
  z.object({ type: z.literal('READING'), reading: ManualReading, placements: z.array(z.object(target).strict()).max(100) }).strict(),
  z.object({ type: z.literal('RETRY_STORED') }).strict(),
  z.object({ type: z.literal('REREAD') }).strict(),
  z.object({ type: z.enum(['CONFIRM', 'DEFER', 'ENGINEERING', 'RECHECK']) }).strict(),
]);
export const PreviewInput = z.object({ correction: Correction, note: z.string().trim().min(3).max(1000), evidence }).strict();
export const ApplyInput = PreviewInput.extend({ fingerprint: z.string().length(64), requestId: z.string().min(8).max(100) }).strict();
export const ListInput = z.object({
  tab: z.enum(['decision', 'waiting', 'engineering', 'history']).default('decision'),
  service: z.enum(['ALL', 'ELECTRICITY', 'WATER']).default('ALL'), source: z.string().max(200).optional(), municipality: z.string().max(100).optional(),
  category: z.string().max(100).optional(), age: z.enum(['all', 'day', 'week', 'older']).default('all'), q: z.string().max(200).optional(),
  sampled: z.enum(['true', 'false']).default('false'), offset: z.coerce.number().int().min(0).max(1000000).default(0), limit: z.coerce.number().int().min(1).max(100).default(50),
});
export class ReviewError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}
