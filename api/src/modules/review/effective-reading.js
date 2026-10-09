import { ManualReading, fingerprint, sourceMediaHash } from './contracts.js';

// Shared by processing, inspection, quality and the CLI. Human readings do not pretend to be AI extractions.
export function effectiveExtraction(post, machine) {
  const override = post.readingOverride;
  if (!override) return machine;
  const basicSource = fingerprint({ service: post.serviceType, text: post.noteTweetText || post.text });
  if (override.schemaVersion !== 1 || override.serviceType !== post.serviceType || override.payload?.sourceTextHash !== basicSource || (override.payload?.sourceMediaHash && (!Array.isArray(post.PostMedia) || override.payload.sourceMediaHash !== sourceMediaHash(post)))) {
    return { ...(machine ?? {}), status: 'NEEDS_REVIEW', result: null, humanConflict: true, error: 'The human reading is incompatible with the current source. Review it before processing.' };
  }
  const parsed = ManualReading.safeParse(override.payload.reading);
  if (!parsed.success) return { ...(machine ?? {}), status: 'NEEDS_REVIEW', result: null, humanConflict: true, error: 'The saved human reading needs migration.' };
  const reading = parsed.data;
  const faults = reading.faults.map((f) => ({ ...f, localities: f.localities.map((l) => reading.serviceType === 'WATER' ? { ...l, state: l.impact === 'RESTORED' ? 'RESTORED' : 'AFFECTED' } : l) }));
  const first = faults[0];
  const result = {
    ...(machine?.result ?? {}), ...first, sdc: reading.sdc ?? null,
    update_summary: first.summary, faults: [], review_reason: null,
    __human: { revision: override.revision, schemaVersion: override.schemaVersion }, __humanFaults: faults,
  };
  return { ...(machine ?? {}), postId: post.id, promptVersion: 'human.v1', status: 'SUCCEEDED', relevance: first.relevance, result, human: true, error: null };
}

export function humanFaultItems(extraction) {
  if (!extraction?.result?.__humanFaults) return null;
  return extraction.result.__humanFaults.map((fault) => ({ faultIndex: fault.faultIndex, fromDigest: extraction.result.__humanFaults.length > 1,
    extraction: { ...extraction, relevance: fault.relevance, result: { ...extraction.result, ...fault, update_summary: fault.summary, faults: [] } },
  }));
}

export function manualDraft(post, items) {
  const serviceType = post.serviceType;
  return {
    serviceType, ...(serviceType === 'ELECTRICITY' ? { sdc: items[0]?.extraction.result.sdc ?? null } : {}),
    faults: items.map(({ faultIndex, extraction: e }) => {
      const r = e.result;
      const base = { faultIndex, relevance: e.relevance === 'SDC_SUMMARY' ? 'GENERAL_NOTICE' : e.relevance, status: r.status ?? 'UNKNOWN', cause: r.cause ?? null, eta_text: r.eta_text ?? null,
        restoration_percent: r.restoration_percent ?? null, summary: r.update_summary ?? r.summary ?? '',
        entities: (r.entities ?? []).filter((a) => serviceType === 'WATER' || a.type !== 'SDC').map((a) => ({ type: a.type, name: a.name, parent_name: a.parent_name ?? null,
          ...(serviceType === 'WATER' ? { operator: a.operator ?? null, relationType: a.relationType ?? null } : {}) })),
        localities: (r.localities ?? []).map((l) => serviceType === 'WATER' ? { name: l.name, impact: l.impact ?? (l.state === 'RESTORED' ? 'RESTORED' : 'AFFECTED') } : { name: l.name, state: l.state ?? 'UNKNOWN' }),
      };
      return serviceType === 'WATER' ? { ...base, water_state: r.water_state ?? 'UNKNOWN', customer_supply: r.customer_supply ?? null, systems: r.systems ?? [] } : base;
    }),
  };
}
