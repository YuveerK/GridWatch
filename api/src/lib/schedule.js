const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const DATE = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(20\d{2}))?/gi;
const RANGE = /\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:and|&|-|–|—|to)\s*(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(20\d{2}))?/gi;
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
  // "22 and 23 September" is two days, the first and the last; the last date found by the plain rule is only its second day
  let range = null;
  for (const m of text.matchAll(RANGE)) if (last.index >= m.index && last.index <= m.index + m[0].length) range = m;
  const day = Number(range ? range[1] : last[1]);
  const endDay = range ? Number(range[2]) : null;
  const month = MONTHS[last[2].toLowerCase()];
  let year = Number(last[3] ?? refDate.getUTCFullYear());
  if (!last[3] && validDate(year, month, day) && Date.UTC(year, month - 1, day) < refDate.getTime() - 90 * 86_400_000) year += 1;
  if (!validDate(year, month, day)) return null;
  const endOk = endDay != null && endDay > day && validDate(year, month, endDay);
  const after = text.slice(last.index + last[0].length);
  const t = TIME.exec(after) ?? TIME.exec(text.slice(0, last.index));
  const ok = t && validTime(Number(t[1]), Number(t[2])) && validTime(Number(t[3]), Number(t[4]));
  return { date: `${year}-${pad(month)}-${pad(day)}`, ...(endOk ? { endDate: `${year}-${pad(month)}-${pad(endDay)}` } : {}), from: ok ? `${pad(t[1])}:${t[2]}` : null, to: ok ? `${pad(t[3])}:${t[4]}` : null };
}

/**
 * The announced window as UTC instants: { start, end } (ISO strings), or null when no date can be read.
 * Times are Johannesburg local. A window whose end is before its start runs overnight into the next day; with no time
 * given the whole local day is the window. Looks in the post text first, then the reading's own text (image
 * transcription, summary), so announcements made only in a graphic still get a window.
 */
/** Just a time window ("09h00 until 17h00"), for when the date is stated somewhere else. */
export function parseTimes(text) {
  const t = text ? TIME.exec(text) : null;
  if (!t || !validTime(Number(t[1]), Number(t[2])) || !validTime(Number(t[3]), Number(t[4]))) return null;
  return { from: `${pad(t[1])}:${t[2]}`, to: `${pad(t[3])}:${t[4]}` };
}

/**
 * One item inside a weekly-schedule graphic ("Tuesday, 22 September • Beyers … Wednesday, 23 September • Heriotdale …"): its day is the
 * nearest date heading ABOVE its own line, not the last date anywhere in the graphic. `names` are the item's equipment names.
 * Returns a schedule like parseSchedule's, or null when the item cannot be found or nothing dated comes before it.
 */
const WEEKDAY = '(?:mon|tues|wednes|thurs|fri|satur|sun)day';
const MONTH_NAMES = 'january|february|march|april|may|june|july|august|september|october|november|december';
const WEEKDAY_HEADING = new RegExp(`\\b${WEEKDAY}(?:\\s*(?:,|and|&)\\s*${WEEKDAY})*\\s*,?\\s*\\d{1,2}(?:st|nd|rd|th)?(?:\\s*(?:and|&|-|–|—|to)\\s*\\d{1,2}(?:st|nd|rd|th)?)?\\s+(?:${MONTH_NAMES})(?:\\s+20\\d{2})?`, 'gi');

export function anchoredSchedule(imageText, names, etaText, refDate = new Date()) {
  if (!imageText) return null;
  const escape = (n) => n.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  let at = -1;
  for (const n of names.filter((x) => x && x.trim().length >= 3)) {
    const m = new RegExp(`\\b${escape(n)}\\b`, 'i').exec(imageText);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  if (at < 0) return null;
  // Only a WEEKDAY heading counts ("Wednesday, 23 September"). A bare date before the item is usually the issue date of the picture
  // ("Update 21 September 2026 15:50") or an unrelated sentence ("the outage occurred yesterday, 20 September"), not when this item happens.
  // It must also sit close by: a digest that reports several unrelated items in turn can mention a full date in an EARLIER item's own
  // sentence ("...restored, following the outage reported on Monday, 21 September..."), and that date belongs to that other item, not
  // to this one, however far back it happens to be the nearest one found. A real heading sits right before its item (a bullet or a dash).
  const NEARBY_CHARS = 200;
  let heading = null;
  for (const m of imageText.slice(0, at).matchAll(WEEKDAY_HEADING)) {
    if (at - (m.index + m[0].length) <= NEARBY_CHARS) heading = m[0];
  }
  const sch = heading ? parseSchedule(heading, refDate) : null;
  if (!sch) return null;
  const times = parseTimes(etaText) ?? parseTimes(imageText.slice(at, at + 260));
  return { ...sch, from: times?.from ?? null, to: times?.to ?? null };
}

export function scheduleWindow(extraction, text, refDate = new Date()) {
  const r = extraction?.result ?? {};
  const sources = [text, extraction?.imageText, r.image_text, r.update_summary, r.eta_text];
  // An item read out of a graphic (no post text of its own). Its OWN words come first ("scheduled for Wednesday, 23 September 2026 from 09h00 until
  // 17h00"), and only when they name no date does its day come from the heading above it in the graphic (a weekly schedule lists dates as headings).
  // Never the last date anywhere in the picture, and never just the nearest date before the item: an unrelated sentence can sit in between.
  const fromGraphic = !text && r.image_text;
  const ownWords = fromGraphic ? [r.eta_text, r.update_summary].map((x) => parseSchedule(x, refDate)) : [];
  const heading = fromGraphic ? anchoredSchedule(r.image_text, (r.entities ?? []).filter((e) => e.type !== 'SDC').map((e) => e.name), r.eta_text, refDate) : null;
  // (no date of its own and no weekday heading: no window at all, so it cannot overwrite the window the planned posts gave)
  const candidates = fromGraphic ? [...ownWords, heading] : sources.map((s) => parseSchedule(s, refDate));
  for (const found of candidates) {
    let sch = found;
    if (!sch) continue;
    // the date is in the post text but the hours are often only in the graphic or the estimate: take them from wherever they are
    if (!sch.from) {
      const times = sources.map(parseTimes).find(Boolean);
      if (times) sch = { ...sch, ...times };
    }
    const [y, m, d] = sch.date.split('-').map(Number);
    const local = (day, hhmm) => {
      const [h, min] = hhmm.split(':').map(Number);
      return new Date(Date.UTC(y, m - 1, day, h - SAST_OFFSET_HOURS, min));
    };
    const start = local(d, sch.from ?? '00:00');
    // a range ends on its last day at the closing hour; a single day may run overnight into the next
    const endDay = sch.endDate ? Number(sch.endDate.split('-')[2]) : d;
    let end = local(endDay, sch.to ?? '24:00');
    if (!sch.endDate && sch.from && sch.to && end <= start) end = local(d + 1, sch.to);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  return null;
}
