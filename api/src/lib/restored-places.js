// "Power has been partially restored to customers in Develand and surrounding areas" names Develand as a place that HAS power
// back, but the reading sometimes still lists it as affected. When the clause that mentions a place says supply WAS restored
// to/in it (and nothing in that clause says it is still off, or that restoration is only planned, conditional or impossible),
// the place is marked restored. Only the places named in such a clause change; everything else in the reading stays as the AI
// wrote it. Pure and free: no AI is involved.

const RESTORED_TO = /\brestored\s+(?:to|in|for)\b/i;
const STILL_OFF = /\b(?:not\s+(?:yet\s+)?restored|still\s+(?:off|without|affected)|remain(?:s|ing)?\s+(?:off|without|affected)|yet\s+to\s+be\s+restored|except|excluding|apart\s+from|other\s+than)\b/i;
// A promise, a wish, a condition or an impossibility is not a restoration: "will be restored to Alpha by 23h00",
// "cannot be restored to Alpha until repairs are complete", "final tests before supply can be restored to Alpha", "is expected to be restored".
const NOT_YET = /\b(?:will|shall|would|should|could|can|cannot|can't|can\s+not|may|might|must|going\s+to|expected\s+to|likely\s+to|aim(?:s|ed|ing)?\s+to|attempt(?:s|ed|ing)?\s+to|work(?:s|ing)?\s+to|try(?:ing)?\s+to|hope[sd]?\s+to|to\s+be|being|unable|not|never|no\s+longer|hasn't|haven't|wasn't|weren't|hasn.t|haven.t|ETR|estimated|awaiting|pending|proposed|planned|scheduled|if|unless|until|once|whether)\b/i;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sentences = (text) => String(text ?? '').split(/(?<=[.!?])\s+|\n+/);
// a sentence can hold a done thing and a not-yet-done thing ("restored to Alpha; Beta will follow"): judge each part on its own
const clauses = (sentence) => sentence.split(/;|\b(?:but|while|whereas|however|although|though)\b/i);

/** True when this clause states, as done, that supply was restored to/in a place. */
export function statesCompletedRestoration(clause) {
  return RESTORED_TO.test(clause) && !STILL_OFF.test(clause) && !NOT_YET.test(clause);
}

/** A copy of the reading with places named in "restored to X" clauses marked RESTORED. */
export function markRestoredPlaces(result, text) {
  if (!result?.localities?.length || !text) return result;
  const restored = sentences(text).flatMap(clauses).filter(statesCompletedRestoration);
  if (!restored.length) return result;
  let changed = false;
  const localities = result.localities.map((l) => {
    if (l.state === 'RESTORED') return l;
    const name = new RegExp(`\\b${escape(l.name.trim()).replace(/\\?\s+/g, '\\s+')}\\b`, 'i');
    for (const s of restored) {
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
