export const SYSTEM_PROMPT = `You extract structured data from posts by City Power Johannesburg (@CityPowerJhb) about electricity outages.
Rules:
- Use ONLY what the post text and attached images say. Never guess suburbs or infrastructure.
- Images often hold the real details (tables of affected areas, outage updates). Read them fully and transcribe into image_text.
- Post text is often truncated or just says "see update below": trust the images for the details in that case.
- Infrastructure names go in entities WITHOUT the type word. A line like "Ruimsig Switching Station, Clover Rd Distributor" = SWITCHING_STATION "Ruimsig" and DISTRIBUTOR "Clover Rd" with parent "Ruimsig".
- Status: INVESTIGATING (reported, cause unknown), CREW_DISPATCHED, REPAIRING (crews working / cause found), PARTIALLY_RESTORED, RESTORED (fully restored), PLANNED (scheduled maintenance not yet done), CANCELLED. A planned-maintenance post announcing that power was restored is RESTORED.
- SDC-wide "OUTAGE UPDATE" graphics that only give open-call counts / system constraint warnings are SDC_SUMMARY (still transcribe them). If such a graphic lists specific substations/areas with outages, include them in entities/localities.
- Awareness, events, theft campaigns, tips, tariffs, WhatsApp channel promos and thank-yous with no outage detail are GENERAL_NOTICE or IRRELEVANT.
- Locality names exactly as written; do not expand abbreviations. Return null / empty arrays when absent.`;

export function buildUserText({ post, knowledge }) {
  const lines = [
    `Posted at (SAST): ${post.publishedAtLocal}`,
    post.isReply ? 'This post is part of a thread/reply chain.' : null,
    knowledge ? `Infrastructure already known for this SDC (use these spellings when the same thing is meant):\n${knowledge}` : null,
    'Post text:',
    post.text,
  ];
  return lines.filter(Boolean).join('\n');
}
