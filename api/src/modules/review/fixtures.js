import { inspectCase } from './inspection.js';
import { pairsFromOverrides } from '../outages/corrections.js';

// The web and CLI export the same reviewed evidence. Only an engineer writes repository fixtures.
export async function exportReviewFixture(id, db) {
  const d = await inspectCase(id, db);
  const rows = [];
  for (const o of d.overrides ?? []) {
    const anchor = o.anchorPostId ? await db.sourcePost.findUnique({ where: { id: o.anchorPostId },select: { externalId: true } }) : null;
    const contrast = o.contrastPostId ? await db.sourcePost.findUnique({ where: { id: o.contrastPostId },select: { externalId: true } }) : null;
    rows.push({ postExternalId: d.externalId,faultIndex: o.faultIndex,action: o.action,anchorExternalId: anchor?.externalId,anchorFaultIndex: o.anchorFaultIndex,contrastExternalId: contrast?.externalId,note: o.note });
  }
  return { ...pairsFromOverrides(rows),reading: d.readingOverride ? { post: d.externalId,serviceType: d.serviceType,reading: d.readingDraft,evidence: d.readingOverride.evidence,note: d.readingOverride.note,_kind: 'regression' } : null };
}
