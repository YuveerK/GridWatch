import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { ApiError, api, type ServiceName } from '@/src/lib/api';

const PREFS_KEY = 'gridwatch.prefs';
export const ALERTS_OFF = 'Alerts are not being sent yet';

export type Suburb = { id: string; name: string };
export type Quiet = { from: number | null; to: number | null };

type Prefs = {
  suburb: Suburb | null;
  following: Suburb[];
  service: ServiceName;
  quiet: Quiet;
  token: string | null;
};

type AlertResult = { alerts: boolean; message: string | null };

type AppContextValue = {
  ready: boolean;
  service: ServiceName;
  setService: (service: ServiceName) => void;
  suburb: Suburb | null;
  setSuburb: (suburb: Suburb | null) => void;
  following: Suburb[];
  quiet: Quiet;
  alerts: boolean;
  follow: (suburb: Suburb) => Promise<AlertResult>;
  unfollow: (id: string) => Promise<void>;
  setQuiet: (from: number | null, to: number | null) => Promise<void>;
};

const empty: Prefs = {
  suburb: null,
  following: [],
  service: 'ELECTRICITY',
  quiet: { from: null, to: null },
  token: null,
};

const AppContext = createContext<AppContextValue | null>(null);

function hourOrNull(value: unknown) {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 23 ? (value as number) : null;
}

async function loadPrefs(): Promise<Prefs> {
  const raw = await AsyncStorage.getItem(PREFS_KEY);
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    const from = hourOrNull(parsed.quiet?.from);
    const to = hourOrNull(parsed.quiet?.to);
    return {
      suburb: parsed.suburb?.id ? { id: String(parsed.suburb.id), name: String(parsed.suburb.name ?? '') } : null,
      following: Array.isArray(parsed.following)
        ? parsed.following.filter((item: { id?: string }) => item?.id).map((item: { id: string; name?: string }) => ({ id: String(item.id), name: String(item.name ?? '') })).slice(0, 20)
        : [],
      service: parsed.service === 'WATER' ? 'WATER' : 'ELECTRICITY',
      quiet: from == null || to == null ? { from: null, to: null } : { from, to },
      token: typeof parsed.token === 'string' ? parsed.token : null,
    };
  } catch {
    return empty;
  }
}

async function pushToken() {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  const result = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  return result.data;
}

async function syncAlerts(following: Suburb[], quiet: Quiet, ask: boolean): Promise<AlertResult & { token: string | null }> {
  if (Platform.OS === 'web') return { alerts: false, message: ALERTS_OFF, token: null };
  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted' && ask) status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return { alerts: false, message: ALERTS_OFF, token: null };
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Outages',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  let token: string;
  try {
    token = await pushToken();
  } catch {
    return { alerts: false, message: ALERTS_OFF, token: null };
  }
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  try {
    await api.registerDevice({ token, platform, quietFrom: quiet.from, quietTo: quiet.to });
    await api.replaceSubscriptions(token, following.map((item) => item.id));
    return { alerts: true, message: null, token };
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'push_disabled' || error.status === 503)) {
      return { alerts: false, message: ALERTS_OFF, token };
    }
    return { alerts: false, message: ALERTS_OFF, token };
  }
}

export function AppState({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(empty);
  const [ready, setReady] = useState(false);
  const [alerts, setAlerts] = useState(false);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const commit = useCallback((next: Prefs) => {
    prefsRef.current = next;
    setPrefs(next);
  }, []);

  useEffect(() => {
    let live = true;
    loadPrefs().then(async (loaded) => {
      if (!live) return;
      commit(loaded);
      setReady(true);
      if (loaded.token || loaded.following.length) {
        const result = await syncAlerts(loaded.following, loaded.quiet, false);
        if (!live) return;
        setAlerts(result.alerts);
        if (result.token && result.token !== loaded.token) commit({ ...prefsRef.current, token: result.token });
      }
    });
    return () => {
      live = false;
    };
  }, [commit]);

  useEffect(() => {
    if (!ready) return;
    AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs)).catch(() => undefined);
  }, [prefs, ready]);

  const value = useMemo<AppContextValue>(() => ({
    ready,
    service: prefs.service,
    suburb: prefs.suburb,
    following: prefs.following,
    quiet: prefs.quiet,
    alerts,
    setService: (service) => commit({ ...prefsRef.current, service }),
    setSuburb: (suburb) => commit({ ...prefsRef.current, suburb }),
    follow: async (suburb) => {
      const current = prefsRef.current;
      if (current.following.length >= 20 && !current.following.some((item) => item.id === suburb.id)) {
        return { alerts: false, message: 'You can follow up to 20 suburbs.' };
      }
      const following = current.following.some((item) => item.id === suburb.id)
        ? current.following
        : [...current.following, suburb];
      commit({ ...current, following });
      const result = await syncAlerts(following, current.quiet, true);
      setAlerts(result.alerts);
      if (result.token) commit({ ...prefsRef.current, token: result.token });
      return { alerts: result.alerts, message: result.message };
    },
    unfollow: async (id) => {
      const current = prefsRef.current;
      const following = current.following.filter((item) => item.id !== id);
      commit({ ...current, following });
      if (!current.token) return;
      try {
        await api.replaceSubscriptions(current.token, following.map((item) => item.id));
      } catch (error) {
        if (error instanceof ApiError && (error.code === 'push_disabled' || error.status === 503)) setAlerts(false);
      }
    },
    setQuiet: async (from, to) => {
      if ((from == null) !== (to == null)) return;
      const current = prefsRef.current;
      const quiet = { from, to };
      commit({ ...current, quiet });
      if (!current.token && current.following.length === 0) return;
      const result = await syncAlerts(current.following, quiet, false);
      setAlerts(result.alerts);
      if (result.token) commit({ ...prefsRef.current, token: result.token });
    },
  }), [alerts, commit, prefs, ready]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp outside AppState');
  return value;
}
