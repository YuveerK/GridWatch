const PRICE = { 'gemini-3.5-flash-lite': [0.3, 2.5], 'gemini-3.1-flash-lite': [0.25, 1.5], 'gemini-3.6-flash': [0.75, 3.75] };

/** Text for `npm run health`. `report` is stored operational data; this does not call X or Gemini. */
export function formatHealth(report) {
  const lines = ['SOURCE HEALTH', ''];
  for (const a of report.accounts) {
    lines.push(`${a.displayName} / ${a.serviceType}`);
    lines.push(`  active              ${a.active ? 'yes' : 'no'}`);
    lines.push(`  last poll           ${a.lastPoll ?? '-'}`);
    lines.push(`  last new post       ${a.lastNewPost ?? '-'}`);
    lines.push(`  latest X id         ${a.latestExternalId ?? '-'}`);
    lines.push(`  current backlog     ${a.backlog ?? 0}`);
    lines.push(`  processing errors   ${a.errors ?? 0}`);
    lines.push(`  open reviews        ${a.openReviews ?? 0}`);
    lines.push('');
  }
  const p = report.pipeline;
  lines.push('PIPELINE');
  lines.push(`  latest cycle        ${p.cycle ?? '-'}`);
  lines.push(`  lease held          ${p.leaseHeld ? 'yes' : 'no'}`);
  lines.push(`  unprocessed         ${p.unprocessed ?? 0}`);
  lines.push(`  stuck               ${p.stuck ?? 0}`);
  lines.push('');
  const act = report.activity;
  const [inP, outP] = PRICE[act.model] ?? [0.3, 2.5];
  const gemini = ((act.inputTokens ?? 0) * inP + (act.outputTokens ?? 0) * outP) / 1e6;
  lines.push('LATEST ACTIVITY');
  lines.push(`  posts last 24h      ${act.posts ?? 0}`);
  lines.push(`  incidents opened    ${act.opened ?? 0}`);
  lines.push(`  incidents updated   ${act.updated ?? 0}`);
  lines.push(`  Gemini calls        ${act.geminiCalls ?? 0}`);
  lines.push(`  estimated cost      $${(gemini + (act.posts ?? 0) * 0.005).toFixed(3)}`);
  return lines.join('\n');
}
