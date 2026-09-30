import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState as AppLifecycle, Linking, Platform } from 'react-native';
import { createPreferenceReconciler } from '@/src/lib/alert-sync.js';
import { ALERT_COPY, normalizeQuiet } from '@/src/lib/alerts.js';
import { ApiError, api, type ServiceName } from '@/src/lib/api';

const PREFS_KEY = 'gridwatch.prefs';
export const ALERTS_OFF = ALERT_COPY.unavailable;

export type AlertStatus = 'checking' | 'enabled' | 'denied' | 'unavailable' | 'failed' | 'off';

export type Suburb = { id: string; name: string };
export type Quiet = { from: number | null; to: number | null };

type Prefs = {
  suburb: Suburb | null;
  following: Suburb[];
  service: ServiceName;
  quiet: Quiet;
  token: string | null;
};

type AlertResult = { alerts: boolean; status: AlertStatus; message: string };

type QuietResult = { synced: boolean; message: string };

type AppContextValue = {
  ready: boolean;
  service: ServiceName;
  setService: (service: ServiceName) => void;
  suburb: Suburb | null;
  setSuburb: (suburb: Suburb | null) => void;
  following: Suburb[];
  quiet: Quiet;
  alerts: boolean;
  alertStatus: AlertStatus;
  alertMessage: string;
  notice: string | null;
  pendingSync: boolean;
  clearNotice: () => void;
  retryAlerts: () => Promise<void>;
  openAlertSettings: () => void;
  follow: (suburb: Suburb) => Promise<AlertResult>;
  unfollow: (id: string) => Promise<void>;
  setQuiet: (from: number | null, to: number | null) => Promise<QuietResult>;
  now: number;
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

function alertResult(status: AlertStatus, token: string | null = null): AlertResult & { token: string | null } {
  return { alerts: status === 'enabled', status, message: ALERT_COPY[status], token };
}

async function syncAlerts(following: Suburb[], quiet: Quiet, ask: boolean, hooks?: { stillCurrent?: () => boolean }): Promise<AlertResult & { token: string | null; obsolete?: boolean }> {
  const current = () => (hooks?.stillCurrent ? hooks.stillCurrent() : true);
  if (!current()) return { ...alertResult('failed'), obsolete: true };
  if (Platform.OS === 'web') return alertResult('unavailable');
  let existing;
  try {
    existing = await Notifications.getPermissionsAsync();
  } catch {
    return alertResult('failed');
  }
  let status = existing.status;
  try {
    if (status !== 'granted' && ask) status = (await Notifications.requestPermissionsAsync()).status;
  } catch {
    return alertResult('failed');
  }
  if (status !== 'granted') return alertResult(ask || existing.status === 'denied' ? 'denied' : 'off');
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Outages',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
  } catch {
    return alertResult('failed');
  }
  let token: string;
  try {
    token = await pushToken();
  } catch {
    return alertResult('failed');
  }
  if (!current()) return { ...alertResult('failed'), obsolete: true, token };
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  try {
    await api.registerDevice({ token, platform, quietFrom: quiet.from, quietTo: quiet.to });
    if (!current()) return { ...alertResult('failed'), obsolete: true, token };
    await api.replaceSubscriptions(token, following.map((item) => item.id));
    if (!current()) return { ...alertResult('failed'), obsolete: true, token };
    return alertResult('enabled', token);
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'push_disabled' || error.status === 503)) {
      return { ...alertResult('unavailable'), token };
    }
    return { ...alertResult('failed'), token };
  }
}

export function AppState({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(empty);
  const [ready, setReady] = useState(false);
  const [alertStatus, setAlertStatus] = useState<AlertStatus>('off');
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingSync, setPendingSync] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const prefsRef = useRef(prefs);
  const reconciler = useRef<ReturnType<typeof createPreferenceReconciler> | null>(null);

  const commit = useCallback((next: Prefs) => {
    prefsRef.current = next;
    setPrefs(next);
  }, []);

  const applySync = useCallback((outcome: { obsolete?: boolean; skipped?: boolean; pending?: boolean; status?: AlertStatus; token?: string | null; abandoned?: boolean } | void) => {
    if (!outcome || outcome.skipped) return;
    if (outcome.obsolete) {
      setPendingSync(true);
      return;
    }
    if (outcome.status) setAlertStatus(outcome.status);
    const needsRetry = outcome.status === 'failed' || outcome.status === 'unavailable' || Boolean(outcome.abandoned);
    setPendingSync(needsRetry);
    if (outcome.token) commit({ ...prefsRef.current, token: outcome.token });
    if (needsRetry) setNotice('Saved on this phone. Alerts could not sync. Retry.');
  }, [commit]);

  useEffect(() => {
    if (reconciler.current) return;
    reconciler.current = createPreferenceReconciler({
      readDesired: () => prefsRef.current,
      sync: syncAlerts,
    });
  }, []);

  useEffect(() => {
    let live = true;
    loadPrefs().then(async (loaded) => {
      if (!live) return;
      commit(loaded);
      setReady(true);
      if (loaded.token || loaded.following.length) {
        setAlertStatus('checking');
        reconciler.current!.run(false).then((outcome) => {
          if (live) applySync(outcome);
        }).catch(() => {
          if (live) setPendingSync(true);
        });
      }
    });
    return () => {
      live = false;
    };
  }, [applySync, commit]);

  useEffect(() => {
    if (!ready) return;
    AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs)).catch(() => undefined);
  }, [prefs, ready]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 60_000);
    const sub = AppLifecycle.addEventListener('change', (state) => {
      if (state === 'active') {
        tick();
        reconciler.current!.run(false).then(applySync).catch(() => setPendingSync(true));
      }
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [applySync]);

  const value = useMemo<AppContextValue>(() => ({
    ready,
    service: prefs.service,
    suburb: prefs.suburb,
    following: prefs.following,
    quiet: prefs.quiet,
    alerts: alertStatus === 'enabled',
    alertStatus,
    alertMessage: ALERT_COPY[alertStatus],
    notice,
    pendingSync,
    clearNotice: () => setNotice(null),
    retryAlerts: async () => {
      applySync(await reconciler.current!.run(false));
    },
    openAlertSettings: () => {
      Linking.openSettings().catch(() => undefined);
    },
    setService: (service) => commit({ ...prefsRef.current, service }),
    setSuburb: (suburb) => commit({ ...prefsRef.current, suburb }),
    follow: async (suburb) => {
      const current = prefsRef.current;
      if (current.following.length >= 20 && !current.following.some((item) => item.id === suburb.id)) {
        return { alerts: false, status: 'off' as AlertStatus, message: 'You can follow up to 20 suburbs. Remove one from Following to add another.' };
      }
      const following = current.following.some((item) => item.id === suburb.id)
        ? current.following
        : [...current.following, suburb];
      commit({ ...current, following });
      const outcome = await reconciler.current!.run(true);
      if (outcome.obsolete || outcome.skipped) return { alerts: alertStatus === 'enabled', status: alertStatus, message: ALERT_COPY[alertStatus] };
      applySync(outcome);
      const status = (outcome.status ?? alertStatus) as AlertStatus;
      const message = status === 'failed' || status === 'unavailable' ? 'Saved on this phone. Alerts could not sync. Retry.' : ALERT_COPY[status];
      return { alerts: status === 'enabled', status, message };
    },
    unfollow: async (id) => {
      const current = prefsRef.current;
      const following = current.following.filter((item) => item.id !== id);
      commit({ ...current, following });
      if (!current.token && following.length === 0) return;
      applySync(await reconciler.current!.run(false));
    },
    now,
    setQuiet: async (from, to) => {
      const normalized = normalizeQuiet(from, to);
      const current = prefsRef.current;
      const quiet = { from: normalized.from, to: normalized.to };
      commit({ ...current, quiet });
      const localNote = normalized.clearedBecauseEqual
        ? 'Equal hours turn quiet hours off.'
        : 'Saved on this phone.';
      if (!current.token && current.following.length === 0) {
        return { synced: false, message: localNote };
      }
      const result = await reconciler.current!.run(false);
      if (result.obsolete) return { synced: false, message: localNote };
      applySync(result);
      if (result.skipped) return { synced: false, message: localNote };
      return {
        synced: result.status === 'enabled',
        message: result.status === 'enabled' ? `${localNote} Alert settings synchronized.` : result.status === 'failed' || result.status === 'unavailable' ? `${localNote} Alerts could not sync. Retry.` : `${localNote} ${result.message ?? ''}`.trim(),
      };
    },
  }), [alertStatus, applySync, commit, notice, now, pendingSync, prefs, ready]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp outside AppState');
  return value;
}
