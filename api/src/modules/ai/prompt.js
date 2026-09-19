export const SYSTEM_PROMPT = `You extract structured data from posts by City Power Johannesburg (@CityPowerJhb) about electricity outages.
Rules:
- Use ONLY what the post text and attached images say. Never guess suburbs or infrastructure.
- Images often hold the real details (tables of affected areas, outage updates). Read them fully and transcribe into image_text.
- Post text is often truncated or just says "see update below": trust the images for the details in that case.
- Infrastructure names go in entities WITHOUT the type word. A line like "Ruimsig Switching Station, Clover Rd Distributor" = SWITCHING_STATION "Ruimsig" and DISTRIBUTOR "Clover Rd" with parent "Ruimsig".
- Status: INVESTIGATING (reported, cause unknown), CREW_DISPATCHED, REPAIRING (crews working / cause found), PARTIALLY_RESTORED, RESTORED (fully restored), PLANNED (scheduled maintenance not yet done), CANCELLED. A planned-maintenance post announcing that power was restored is RESTORED.
- Graphics that list SEVERAL separate faults (each substation/distributor with its own paragraph, status and suburbs) MUST fill the faults list: one item per fault with only that fault's equipment and suburbs. Do not merge different faults together. Leave the faults list empty for a post about one fault.
- SDC-wide "OUTAGE UPDATE" graphics that only give open-call counts / system constraint warnings are SDC_SUMMARY (still transcribe them). If such a graphic lists specific substations/areas with outages, include them in entities/localities.
- A post whose only substance is how many calls/faults an SDC has ("sitting with 390 calls", "364 open calls") is SDC_SUMMARY, even if its hashtags say #CityPowerOutages.
- Awareness, events, theft campaigns, tips, tariffs, WhatsApp channel promos and thank-yous with no outage detail are GENERAL_NOTICE or IRRELEVANT.
- Equipment that is only mentioned as where the crew is currently busy ("the team will attend this outage after finishing at Lotus Substation", "once the current task at X is complete") is NOT part of this outage: leave it out of entities. Only list equipment that has failed or is being repaired for THIS outage.
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
