const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const DATE = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(20\d{2}))?/gi;
const TIME = /\b(\d{1,2})\s*[h:.]\s*(\d{2})\s*(?:-|–|—|to|until|till)\s*(\d{1,2})\s*[h:.]\s*(\d{2})\b/i;

const pad = (n) => String(n).padStart(2, '0');

/**
 * Pull the scheduled date (and time window) out of a planned-maintenance post.
 * "…which will take place on Wednesday, 16 September 2026, from 09:00-17:00" → { date: '2026-09-16', from: '09:00', to: '17:00' }
 * When a post mentions several dates the last one wins (rescheduling posts state the new date last).
 */
export function parseSchedule(text, refDate = new Date()) {
  if (!text) return null;
  let last = null;
  for (const m of text.matchAll(DATE)) last = m;
  if (!last) return null;
  const day = Number(last[1]);
  const month = MONTHS[last[2].toLowerCase()];
  const year = Number(last[3] ?? refDate.getUTCFullYear());
  if (day < 1 || day > 31) return null;
  const t = TIME.exec(text);
  return { date: `${year}-${pad(month)}-${pad(day)}`, from: t ? `${pad(t[1])}:${t[2]}` : null, to: t ? `${pad(t[3])}:${t[4]}` : null };
}
