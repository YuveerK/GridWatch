/** Age of a saved status. A missing timestamp is unknown, never "just now". */
export function savedAgeLabel(savedAt, now = Date.now()) {
  if (savedAt == null || !Number.isFinite(Number(savedAt))) return 'Saved, age unknown';
  return `Saved ${relativeTime(new Date(Number(savedAt)).toISOString(), now)}`;
}

export function relativeTime(iso, now = Date.now()) {
  if (!iso) return 'time unknown';
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'time unknown';
  const min = Math.round(Math.abs(ms) / 60000);
  const suffix = ms >= 0 ? 'ago' : 'from now';
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ${suffix}`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ${suffix}`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ${suffix}`;
}

export function hourLabel(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** A Johannesburg clock time, with a relative age beside it. */
export function clockTime(iso, now = Date.now()) {
  if (!iso) return 'Time unknown';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'Time unknown';
  const clock = new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
  return `${clock} · ${relativeTime(iso, now)}`;
}

export const JOHANNESBURG_TIME = 'Johannesburg time (UTC+2)';
