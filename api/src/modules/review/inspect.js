import { REASONS } from './suspicion.js';

/** Text for `npm run review -- --inspect`. It only formats data the caller already loaded. */
export function formatReviewInspection(d) {
  const lines = [];
  const say = (s = '') => lines.push(s);
  say(`review id      ${d.id}`);
  say(`priority       ${d.priority}`);
  say(`reason         ${(d.reasons ?? []).map((r) => `${r.code}${r.detail ? ` (${r.detail})` : ''}`).join('; ')}`);
  say(`service        ${d.serviceType}`);
  say(`source account ${d.sourceAccount}`);
  say('');
  say(`post id        ${d.postId}`);
  say(`X post         ${d.externalId}`);
  say(`url            https://x.com/${d.sourceAccount}/status/${d.externalId}`);
  say(`published      ${d.publishedAt}`);
  say(`source text    ${d.text || '(none)'}`);
  say(`image text     ${d.imageText || '(none)'}`);
  say('');
  const r = d.reading ?? {};
  say(`reading        ${r.relevance ?? '-'} / ${r.status ?? '-'}`);
  say(`fault index    ${d.faultIndex}`);
  say(`kind           ${d.kind ?? '-'}`);
  say(`equipment      ${(d.equipment ?? []).join(', ') || '(none)'}`);
  say(`localities     ${(d.localities ?? []).join(', ') || '(none)'}`);
  say(`cause          ${r.cause ?? '-'}`);
  say(`percentage     ${r.restoration_percent ?? '-'}`);
  say(`window         ${d.window ?? '-'}`);
  say('');
  say(`current decision  ${d.decision?.outcome ?? '-'}  ${d.decision?.reason ?? ''}`);
  say('');
  say('candidate incidents:');
  for (const c of d.candidates ?? []) {
    say(`  ${c.id}`);
    say(`    title ${c.title ?? '-'}  status ${c.status ?? '-'}  kind ${c.kind ?? '-'}`);
    say(`    score ${c.score ?? '-'}  ${Array.isArray(c.reasons) ? c.reasons.join('; ') : (c.reasons ?? '')}`);
    say(`    equipment ${(c.equipment ?? []).join(', ') || '(none)'}`);
    say(`    localities ${(c.localities ?? []).join(', ') || '(none)'}`);
    say(`    age ${c.age ?? '-'}`);
  }
  if (!(d.candidates ?? []).length) say('  (none stored)');
  say('');
  say('review reason explanation');
  for (const reason of d.reasons ?? []) say(`  ${reason.code}: ${REASONS[reason.code]?.label ?? reason.detail ?? ''}`);
  if ((d.reasons ?? []).some((r) => /RESTORATION/.test(r.code))) {
    say('');
    say('restoration');
    say(`  preceding   ${(d.preceding ?? []).join('; ') || '(none named)'}`);
    say(`  timeline    ${d.timeline ?? '-'}`);
    say(`  evidence    ${d.restorationEvidence ?? '-'}`);
  }
  if ((d.reasons ?? []).some((r) => r.code === 'EQUIPMENT_IDENTITY')) {
    say('');
    say('equipment identity');
    for (const n of d.identity ?? []) {
      say(`  ${n.name}  type ${n.type}`);
      say(`    aliases ${(n.aliases ?? []).join(', ') || '(none)'}`);
      say(`    parents ${(n.parents ?? []).join(', ') || '(none)'}`);
    }
    say(`  evidence  ${d.identityEvidence ?? 'names are similar; evidence count is still low'}`);
  }
  say('');
  say(suggestedCommands(d));
  return lines.join('\n');
}

/** Commands a person can choose. This does not run them. */
export function suggestedCommands(d) {
  const fault = d.faultIndex ? ` --fault ${d.faultIndex}` : '';
  const post = d.externalId ?? '<post>';
  const anchor = d.candidates?.find((c) => c.openedBy)?.openedBy ?? '<anchorPost>';
  return [
    'Likely actions:',
    '',
    'join:',
    `node scripts/correct-link.js ${post} --join ${anchor}${fault}`,
    '',
    'split:',
    `node scripts/correct-link.js ${post} --split --from <post>${fault}`,
    '',
    'leave unresolved:',
    'no action',
    '',
    're-extract:',
    `node scripts/reprocess.js --reextract ${d.postId ?? '<postId>'}`,
    '',
    'A correction snapshots first, can be reversed, and appends a golden case. Nothing here has been run.',
  ].join('\n');
}
