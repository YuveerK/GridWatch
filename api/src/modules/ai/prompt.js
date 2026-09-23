// Per-account hints so the model doesn't force City Power's own conventions (SDC hashtags, its equipment
// vocabulary) onto a different utility's posts. Add an entry here whenever a new SourceAccount is seeded -
// unknown accounts fall back to a neutral hint that relies only on what the post itself says.
const UTILITY_HINTS = {
  CityPowerJhb: 'The account posting is City Power Johannesburg (@CityPowerJhb). It groups equipment under Service Delivery Centres (SDCs), tagged with an "#XSDC" hashtag, e.g. #RoodepoortSDC.',
  CityTshwane: 'The account posting is the City of Tshwane (@CityTshwane). It does NOT use an "SDC" hashtag convention - leave sdc null unless a post explicitly names one. It organizes electricity operations by numbered Region (1-7) and depot (e.g. Rosslyn, Centurion, Waltloo), and commonly names areas in "Block" form (e.g. "Soshanguve Block S") or numbered extensions (e.g. "Nellmapius X04").',
};
const DEFAULT_HINT = 'The utility posting has no known hashtag/terminology convention yet - rely only on what the post itself says.';

const BASE_PROMPT = `You extract structured data from posts by a South African municipal electricity utility about outages.
Rules:
- Use ONLY what the post text and attached images say. Never guess suburbs or infrastructure.
- Images often hold the real details (tables of affected areas, outage updates). Read them fully and transcribe into image_text.
- Post text is often truncated or just says "see update below": trust the images for the details in that case.
- Infrastructure names go in entities WITHOUT the type word. A line like "Ruimsig Switching Station, Clover Rd Distributor" = SWITCHING_STATION "Ruimsig" and DISTRIBUTOR "Clover Rd" with parent "Ruimsig".
- parent_name records what FED or CAUSED the loss of supply, not a type hierarchy: when the post says one piece of equipment tripped/failed and names OTHER equipment that lost supply as a result, give each of those a parent_name of the one that failed - even when both are the SAME type ("The 33kV line at Harbeespoort Substation tripped. Affected: Swartspruit, Yskor" = SUBSTATION "Harbeespoort" with no parent, SUBSTATION "Swartspruit" and SUBSTATION "Yskor" each with parent "Harbeespoort"). Only when the post gives no such cause-and-effect wording, and just lists several substations with their own separate faults, are they independent (no parent, or use the faults list per rule below).
- Status: INVESTIGATING (reported, cause unknown), CREW_DISPATCHED, REPAIRING (crews working / cause found), PARTIALLY_RESTORED, RESTORED (fully restored), PLANNED (scheduled maintenance not yet done), CANCELLED. A planned-maintenance post announcing that power was restored is RESTORED.
- Graphics that list SEVERAL separate faults (each substation/distributor with its own paragraph, status and suburbs) MUST fill the faults list: one item per fault with only that fault's equipment and suburbs. Do not merge different faults together. Leave the faults list empty for a post about one fault.
- SDC-wide "OUTAGE UPDATE" graphics that only give open-call counts / system constraint warnings are SDC_SUMMARY (still transcribe them). If such a graphic lists specific substations/areas with outages, include them in entities/localities.
- A post whose only substance is how many calls/faults an SDC has ("sitting with 390 calls", "364 open calls") is SDC_SUMMARY, even if its hashtags say #CityPowerOutages.
- Awareness, events, theft campaigns, tips, tariffs, WhatsApp channel promos and thank-yous with no outage detail are GENERAL_NOTICE or IRRELEVANT.
- Equipment that is only mentioned as where the crew is currently busy ("the team will attend this outage after finishing at Lotus Substation", "once the current task at X is complete") is NOT part of this outage: leave it out of entities. Only list equipment that has failed or is being repaired for THIS outage.
- update_summary (and each fault's summary): ONE plain sentence, max 25 words, facts only, written for a resident: what is happening, cause, progress, who is on site, what happens next, time estimate. No hashtags, phone numbers, thanks or apologies.
- Locality names exactly as written; do not expand abbreviations. Return null / empty arrays when absent.`;

/** `sourceAccountName` is SourcePost.sourceAccount / SourceAccount.displayName (e.g. 'CityPowerJhb'). */
export function buildSystemPrompt(sourceAccountName) {
  return `${BASE_PROMPT}\n\n${UTILITY_HINTS[sourceAccountName] ?? DEFAULT_HINT}`;
}

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
