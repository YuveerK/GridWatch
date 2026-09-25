export const WATER_PROMPT_VERSION = 'water-2';

export function buildWaterSystemPrompt() {
  return `You read official Johannesburg Water and Rand Water notices. Return only the JSON schema.
Rules:
- Never mark supply restored only because pumping resumed or a reservoir level improved.
- "Supplying normally" or "supply has been restored" is customer restoration (customer_supply RESTORED, water_state NORMAL).
- "System recovering", "levels improving", or "pumping has resumed" is water_state RECOVERING and customer_supply null.
- "Poor pressure" or "low pressure expected" is still an active customer impact (LOW_PRESSURE).
- "Outlets partially open" is PARTIAL_SUPPLY, not full restoration.
- "Critically low" or "empty" describes the asset. Imply customer impact only if the notice says customers are affected.
- Split a bulletin that gives distinct conditions for different reservoirs, towers or systems into faults[].
- Do not invent a relationship because two assets appear in the same notice. Record SUPPLIES, PUMPS_TO, DIRECTLY_SUPPLIES, PART_OF, UPSTREAM_OF, BYPASSES or BACKFEEDS only when the notice says one asset feeds, supplies or depends on another.
- Use the known-network context to normalise names, not to invent impacts.
- Johannesburg Water and Rand Water are different operators.
- Do not invent electrical substations, feeders, cables or service centres.
- Suburbs are localities, never infrastructure.
- Use only these machine values, never a human label:
  operator: JOHANNESBURG_WATER, RAND_WATER, or UNKNOWN. Null only when the notice names no operator.
  entity type: WATER_SYSTEM, RESERVOIR, WATER_TOWER, PUMP_STATION, DIRECT_FEED, BULK_CONNECTION, BULK_METER, BOOSTER_STATION, TREATMENT_WORKS, PRV, WATER_PIPELINE, WATER_OTHER.
  locality impact: NO_SUPPLY, LOW_PRESSURE, AFFECTED, RESTORED, UNKNOWN. Do not also invent a second state field.
  relationType: SUPPLIES, PUMPS_TO, DIRECTLY_SUPPLIES, PART_OF, UPSTREAM_OF, BYPASSES, BACKFEEDS, or null.
- parent_name and relationType are both null unless the notice explicitly says one named asset feeds another. Do not repeat that fact anywhere else.
- When a fault names no asset, entities is []. When it names no suburb, localities is []. Never emit {}.`;
}

export function buildWaterUserText({ post, knowledge }) {
  const known = knowledge ? `\nKnown water network (names only, do not invent impacts):\n${knowledge}\n` : '';
  return `Posted: ${post.publishedAtLocal}\nReply: ${post.isReply ? 'yes' : 'no'}\n${known}\nNotice:\n${post.text}`;
}
