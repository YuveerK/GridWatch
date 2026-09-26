import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { serviceFromParam, serviceParam } from './status.js';

const STORAGE_KEY = 'gridwatch:service';
const ServiceContext = createContext(null);

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'WATER' ? 'WATER' : 'ELECTRICITY';
  } catch {
    return 'ELECTRICITY';
  }
}

function store(service) {
  try {
    localStorage.setItem(STORAGE_KEY, service);
  } catch {
    // the choice just won't survive a reload
  }
}

/**
 * Power or Water. The address is the source of truth (?service=power|water), so a shared link opens in the service it
 * was shared from; the browser remembers the last choice for links that don't say. The address always carries the
 * current service, so any link copied from it is complete.
 */
export function ServiceProvider({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [stored, setStored] = useState(readStored);
  const fromUrl = serviceFromParam(new URLSearchParams(location.search).get('service'));
  const service = fromUrl ?? stored;

  const withService = useCallback((s) => {
    const params = new URLSearchParams(location.search);
    params.set('service', serviceParam(s));
    navigate({ pathname: location.pathname, search: `?${params}`, hash: location.hash }, { replace: true, state: location.state });
  }, [location, navigate]);

  useEffect(() => {
    document.documentElement.dataset.service = service;
    if (service !== stored) {
      store(service);
      setStored(service);
    }
    if (!fromUrl) withService(service);
  }, [service, stored, fromUrl, withService]);

  const setService = useCallback((s) => {
    store(s);
    setStored(s);
    withService(s);
  }, [withService]);

  const value = useMemo(() => ({ service, setService }), [service, setService]);
  return <ServiceContext.Provider value={value}>{children}</ServiceContext.Provider>;
}

export function useService() {
  const ctx = useContext(ServiceContext);
  return ctx ?? { service: 'ELECTRICITY', setService() {} };
}

/** A link target for `to` in a specific service, e.g. the Water view of a suburb. */
export const inService = (to, service) => `${to}${to.includes('?') ? '&' : '?'}service=${serviceParam(service)}`;
