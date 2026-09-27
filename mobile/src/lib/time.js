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
