import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useApi } from './api.js';

const STORAGE_KEY = 'gridwatch:municipality';
const MunicipalityContext = createContext(null);

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** App-wide "which city am I looking at" scope. Empty code means "all municipalities". Persisted so it survives
 * navigation and reloads; every page threads `municipality` from this into its own API calls. */
export function MunicipalityProvider({ children }) {
  const [code, setCode] = useState(readStored);
  const list = useApi('/v1/municipalities');
  useEffect(() => {
    try {
      code ? localStorage.setItem(STORAGE_KEY, code) : localStorage.removeItem(STORAGE_KEY);
    } catch {
      // private browsing / storage blocked: the choice just won't survive a reload
    }
  }, [code]);
  const options = list.data?.data ?? [];
  // a code from a previous visit that no longer exists (renamed/removed) falls back to "all" rather than filtering to nothing
  useEffect(() => {
    if (code && options.length && !options.some((m) => m.code === code)) setCode('');
  }, [code, options]);
  const value = useMemo(() => ({ code, setCode, options }), [code, options]);
  return <MunicipalityContext.Provider value={value}>{children}</MunicipalityContext.Provider>;
}

/** { code, setCode, options, name, param } - `param` is the ready-to-append query fragment ("" or "municipality=X"). */
export function useMunicipality() {
  const ctx = useContext(MunicipalityContext);
  const name = ctx?.options.find((m) => m.code === ctx.code)?.name ?? null;
  const param = ctx?.code ? `municipality=${encodeURIComponent(ctx.code)}` : '';
  return { ...ctx, name, param };
}

/** Append a municipality filter to a query string that may or may not already have a `?`. */
export function withMunicipality(path, param) {
  if (!param) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${param}`;
}
