/**
 * A customer-alert picture can name many pieces of equipment ("Fort Substation 98% restored as Central Substation repairs
 * continue") and get read as one item. Its subject is what the headline starts with. This finds that one node, or null.
 * Deliberately strict: the node's name must be the first words of the post (hashtags, asterisks and the like ignored).
 */
const clean = (t) => (t ?? '').replace(/#\w+/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/[*_~]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

export function headlineNode(text, nodes) {
  const head = clean(text);
  const hits = nodes
    .filter((n) => n.type !== 'SDC' && n.name)
    .map((n) => ({ n, name: n.name.toLowerCase().trim() }))
    .filter(({ name }) => head === name || head.startsWith(`${name} `) || head.startsWith(`${name},`) || head.startsWith(`${name}:`))
    .sort((a, b) => b.name.length - a.name.length); // "Fort Street" beats "Fort" when both are named
  return hits[0]?.n ?? null;
}

/** The rescored winner must be clearly ahead and reasonably strong, or the post is left alone as before. */
export const HEADLINE_MIN_SCORE = 0.6;
export const HEADLINE_MIN_LEAD = 0.15;
export function pickHeadlineMatch(ranked) {
  const [top, second] = ranked;
  if (!top || top.score < HEADLINE_MIN_SCORE) return null;
  if (second && top.score - second.score < HEADLINE_MIN_LEAD) return null;
  return top;
}
