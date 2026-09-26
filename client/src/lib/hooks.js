import { useCallback, useEffect, useState } from 'react';

const AREA_KEY = 'gridwatch.myArea';
const THEME_KEY = 'gridwatch.theme';
const EVENT = 'gridwatch:change';

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}
function write(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage can be blocked; the UI still works for this session */
  }
  window.dispatchEvent(new Event(EVENT));
}

function useStored(key) {
  const [value, setValue] = useState(() => read(key));
  useEffect(() => {
    const sync = () => setValue(read(key));
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [key]);
  return [value, useCallback((v) => write(key, v), [key])];
}

/** The suburb the visitor saved as "my area" (kept in this browser only). */
export function useMyArea() {
  const [area, setArea] = useStored(AREA_KEY);
  return { area, setArea, clear: () => setArea(null) };
}

/** 'light' | 'dark' | null (follow the system). */
export function useTheme() {
  const [theme, setTheme] = useStored(THEME_KEY);
  // ?theme=light|dark in the URL sets (and remembers) the theme, useful for sharing a specific look
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('theme');
    if (t === 'light' || t === 'dark') setTheme(t);
  }, [setTheme]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme ?? 'dark'; // the operations-room look is dark by default
  }, [theme]);
  const dark = (theme ?? 'dark') === 'dark';
  return { theme, dark, toggle: () => setTheme(dark ? 'light' : 'dark') };
}

export function useDocumentTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · GridWatch` : 'GridWatch · power and water outages';
  }, [title]);
}

/** Re-render every `ms` so "5 min ago" labels stay honest. */
export function useTick(ms = 30_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
