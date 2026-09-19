const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const DATE = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(20\d{2}))?/gi;
const TIME = /\b(\d{1,2})\s*[h:.]\s*(\d{2})\s*(?:-|–|—|to|until|till)\s*(\d{1,2})\s*[h:.]\s*(\d{2})\b/i;

const pad = (n) => String(n).padStart(2, '0');
const SAST_OFFSET_HOURS = 2; // Johannesburg has no daylight saving

const validDate = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const validTime = (h, min) => h >= 0 && h <= 24 && min >= 0 && min <= 59 && !(h === 24 && min > 0);

/**
 * Pull the scheduled date (and time window) out of a planned-maintenance post.
 * "…which will take place on Wednesday, 16 September 2026, from 09:00-17:00" → { date: '2026-09-16', from: '09:00', to: '17:00' }
 * When a post mentions several dates the last one wins (rescheduling posts state the new date last), and the time window
 * is the one stated after that date. A yearless date takes the post's year, or the next year when that would put it
 * months in the past (a "5 January" notice posted in December). Impossible dates or times give null / no window.
 */
export function parseSchedule(text, refDate = new Date()) {
  if (!text) return null;
  let last = null;
  for (const m of text.matchAll(DATE)) last = m;
  if (!last) return null;
  const day = Number(last[1]);
  const month = MONTHS[last[2].toLowerCase()];
  let year = Number(last[3] ?? refDate.getUTCFullYear());
  if (!last[3] && validDate(year, month, day) && Date.UTC(year, month - 1, day) < refDate.getTime() - 90 * 86_400_000) year += 1;
  if (!validDate(year, month, day)) return null;
  const after = text.slice(last.index + last[0].length);
  const t = TIME.exec(after) ?? TIME.exec(text.slice(0, last.index));
  const ok = t && validTime(Number(t[1]), Number(t[2])) && validTime(Number(t[3]), Number(t[4]));
  return { date: `${year}-${pad(month)}-${pad(day)}`, from: ok ? `${pad(t[1])}:${t[2]}` : null, to: ok ? `${pad(t[3])}:${t[4]}` : null };
}

/**
 * The announced window as UTC instants: { start, end } (ISO strings), or null when no date can be read.
 * Times are Johannesburg local. A window whose end is before its start runs overnight into the next day; with no time
 * given the whole local day is the window. Looks in the post text first, then the reading's own text (image
 * transcription, summary), so announcements made only in a graphic still get a window.
 */
export function scheduleWindow(extraction, text, refDate = new Date()) {
  const r = extraction?.result ?? {};
  const sources = [text, extraction?.imageText, r.image_text, r.update_summary, r.eta_text];
  for (const s of sources) {
    const sch = parseSchedule(s, refDate);
    if (!sch) continue;
    const [y, m, d] = sch.date.split('-').map(Number);
    const local = (day, hhmm) => {
      const [h, min] = hhmm.split(':').map(Number);
      return new Date(Date.UTC(y, m - 1, day, h - SAST_OFFSET_HOURS, min));
    };
    const start = local(d, sch.from ?? '00:00');
    let end = local(d, sch.to ?? '24:00');
    if (sch.from && sch.to && end <= start) end = local(d + 1, sch.to);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  return null;
}
