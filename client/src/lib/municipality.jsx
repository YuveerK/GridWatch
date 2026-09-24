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

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Who the site is quoting: the utility of one municipality, or of the scope picked in the switcher.
 *   `which` (optional) pins it to a thing's own municipality - an outage, a suburb or a piece of equipment - by code, id or
 *   name, so a Tshwane outage says "the City of Tshwane" even while "All of Gauteng" is selected.
 * { utility: "City Power" | "the City of Tshwane" | "the utility", Utility (capitalised), accounts: [X handles],
 *   contacts: [{ name, utility, contact }] (one per municipality in scope), single (true when one municipality is in scope) }
 */
export function useUtility(which = null) {
  const { code, options = [] } = useMunicipality();
  const own = which ? options.find((m) => m.code === which || m.id === which || m.name === which) : null;
  const scoped = own ?? options.find((m) => m.code === code) ?? null;
  const inScope = scoped ? [scoped] : options;
  const utility = scoped?.utility ?? 'the utility';
  return {
    utility,
    Utility: cap(utility),
    accounts: inScope.flatMap((m) => m.accounts ?? []),
    contacts: inScope.filter((m) => m.contact).map((m) => ({ name: m.name, utility: m.utility, contact: m.contact })),
    single: Boolean(scoped),
  };
}

/** Append a municipality filter to a query string that may or may not already have a `?`. */
export function withMunicipality(path, param) {
  if (!param) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${param}`;
}
