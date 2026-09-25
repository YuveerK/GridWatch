import { createContext, useContext, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'gridwatch:service';
const ServiceContext = createContext(null);

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'WATER' ? 'WATER' : 'ELECTRICITY';
  } catch {
    return 'ELECTRICITY';
  }
}

export function ServiceProvider({ children }) {
  const [service, setService] = useState(readStored);
  useEffect(() => {
    document.documentElement.dataset.service = service;
    try {
      localStorage.setItem(STORAGE_KEY, service);
    } catch {
      // the choice just won't survive a reload
    }
  }, [service]);
  const value = useMemo(() => ({ service, setService }), [service]);
  return <ServiceContext.Provider value={value}>{children}</ServiceContext.Provider>;
}

export function useService() {
  const ctx = useContext(ServiceContext);
  return ctx ?? { service: 'ELECTRICITY', setService() {} };
}
