// "Power has been partially restored to customers in Develand and surrounding areas" names Develand as a place that HAS power
// back, but the reading sometimes still lists it as affected. When the sentence that mentions a place says supply was
// restored to/in it (and nothing in that sentence says it is still off), the place is marked restored. Only the places named
// in such a sentence change; everything else in the reading stays as the AI wrote it. Pure and free: no AI is involved.

const RESTORED_TO = /\brestored\s+(?:to|in|for)\b/i;
const STILL_OFF = /\b(?:not\s+(?:yet\s+)?restored|still\s+(?:off|without|affected)|remain(?:s|ing)?\s+(?:off|without|affected)|yet\s+to\s+be\s+restored|except|excluding|apart\s+from|other\s+than)\b/i;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sentences = (text) => String(text ?? '').split(/(?<=[.!?])\s+|\n+/);

/** A copy of the reading with places named in "restored to X" sentences marked RESTORED. */
export function markRestoredPlaces(result, text) {
  if (!result?.localities?.length || !text) return result;
  const restoredSentences = sentences(text).filter((s) => RESTORED_TO.test(s) && !STILL_OFF.test(s));
  if (!restoredSentences.length) return result;
  let changed = false;
  const localities = result.localities.map((l) => {
    if (l.state === 'RESTORED') return l;
    const name = new RegExp(`\\b${escape(l.name.trim()).replace(/\\?\s+/g, '\\s+')}\\b`, 'i');
    for (const s of restoredSentences) {
      const at = s.search(RESTORED_TO);
      const hit = s.slice(at).search(name);
      if (hit >= 0) {
        changed = true;
        return { ...l, state: 'RESTORED' };
      }
    }
    return l;
  });
  return changed ? { ...result, localities } : result;
}
