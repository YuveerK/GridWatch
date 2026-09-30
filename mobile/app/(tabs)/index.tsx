import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { applyAreaResult, emptyAreaCache, migrateAreaCache } from '@/src/lib/area-cache.js';
import { withTimeout } from '@/src/lib/deadline.js';
import { areaHeadline, sortOutages } from '@/src/lib/area.js';
import { api, type Outage } from '@/src/lib/api';
import { nearestSuburb } from '@/src/lib/geo.js';
import { readCache, writeCache } from '@/src/lib/storage';
import { relativeTime, savedAgeLabel } from '@/src/lib/time.js';
import { useApp } from '@/src/state/app';
import { Banner, OutageListSkeleton, OutageRow, PrimaryButton, SecondaryButton, StatusIcon, Wordmark } from '@/src/components/ui';
import { colors, font, reading, serviceColor, serviceLabel, toneColor } from '@/src/theme';

type ServiceState =
  | { kind: 'loading' }
  | { kind: 'ok'; rows: Outage[]; stale: boolean; savedAt: number | null }
  | { kind: 'unavailable' };

function viewOf(service: { state: string; rows: Outage[]; stale?: boolean; savedAt: number | null }): ServiceState {
  if (service.state === 'ok') return { kind: 'ok', rows: service.rows, stale: Boolean(service.stale), savedAt: service.savedAt };
  return { kind: 'unavailable' };
}

export default function MyAreaScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { suburb, setSuburb } = useApp();
  const [power, setPower] = useState<ServiceState>({ kind: 'loading' });
  const [water, setWater] = useState<ServiceState>({ kind: 'loading' });
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [savedBanner, setSavedBanner] = useState(false);
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<{ id: string; name: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const request = useRef(0);

  const load = useCallback(async (id: string) => {
    const token = ++request.current;
    setNote(null);
    let latest = emptyAreaCache();
    const seen = { power: false, water: false };
    const publish = () => {
      if (token !== request.current) return;
      if (seen.power || latest.power.state === 'ok') setPower(viewOf(latest.power));
      if (seen.water || latest.water.state === 'ok') setWater(viewOf(latest.water));
      setSavedBanner(Boolean(latest.power.stale || latest.water.stale));
      writeCache(`area:${id}`, latest).catch(() => undefined);
    };
    const cacheRead = readCache(`area:${id}`).then((stored) => migrateAreaCache(stored?.data)).catch(() => emptyAreaCache());
    const powerRequest = withTimeout(api.localityOutages(id, 'ELECTRICITY'));
    const waterRequest = withTimeout(api.localityOutages(id, 'WATER'));
    const syncRequest = withTimeout(api.sync());
    cacheRead.then((cached) => {
      if (token !== request.current) return;
      const keep = (service: 'power' | 'water') => {
        const current = latest[service];
        const remembered = cached[service];
        if (!seen[service]) return remembered.state === 'ok' ? { ...remembered, stale: true } : current;
        if (current.state === 'ok' && !current.stale) return current;
        return remembered.state === 'ok' ? { ...remembered, stale: true } : current;
      };
      latest = { ...latest, power: keep('power'), water: keep('water') };
      publish();
    }).catch(() => undefined);
    const take = (service: 'power' | 'water', result: PromiseSettledResult<{ data: Outage[] }>) => {
      if (token !== request.current || seen[service]) return;
      seen[service] = true;
      latest = applyAreaResult(latest, service, result.status === 'fulfilled' ? { ok: true, rows: result.value.data } : { ok: false });
      publish();
    };
    powerRequest.then((value) => take('power', { status: 'fulfilled', value }), (reason) => take('power', { status: 'rejected', reason }));
    waterRequest.then((value) => take('water', { status: 'fulfilled', value }), (reason) => take('water', { status: 'rejected', reason }));
    const [powerResult, waterResult, syncResult] = await Promise.allSettled([powerRequest, waterRequest, syncRequest, cacheRead]);
    if (token !== request.current) return;
    if (syncResult.status === 'fulfilled') setUpdatedAt(syncResult.value.lastSyncAt);
    if (!seen.power) take('power', powerResult);
    if (!seen.water) take('water', waterResult);
  }, []);

  useEffect(() => {
    if (!suburb) return;
    setPower({ kind: 'loading' });
    setWater({ kind: 'loading' });
    setUpdatedAt(null);
    setSavedBanner(false);
    load(suburb.id).catch(() => undefined);
  }, [suburb, load]);

  const chooseByLocation = async () => {
    if (locating) return;
    setLocating(true);
    setNote(null);
    setSuggestion(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setNote('Location permission is off. Choose a suburb by name.');
        return;
      }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const places = await Location.reverseGeocodeAsync(position.coords);
      const hint = places[0];
      const guesses = [hint?.district, hint?.subregion, hint?.city, hint?.name].filter((value): value is string => Boolean(value && value.length >= 2));
      let match = null;
      for (const guess of guesses) {
        const found = await api.search(guess, 'ELECTRICITY');
        match = nearestSuburb(found.suburbs, position.coords.latitude, position.coords.longitude);
        if (match) break;
      }
      if (!match) {
        setNote('No tracked suburb is close enough. Choose one by name.');
        return;
      }
      setSuggestion({ id: match.id, name: match.name });
    } catch {
      setNote('Location could not be read. Choose a suburb by name.');
    } finally {
      setLocating(false);
    }
  };

  const listed = sortOutages([
    ...(power.kind === 'ok' ? power.rows : []),
    ...(water.kind === 'ok' ? water.rows : []),
  ]);

  return (
    <ScrollView
      contentContainerStyle={[styles.page, { paddingTop: insets.top + 8 }]}
      refreshControl={suburb ? <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(suburb.id).finally(() => setRefreshing(false)); }} tintColor={colors.power} /> : undefined}
    >
      <Wordmark />
      {!suburb && (
        <View style={styles.stack}>
          <Text style={styles.title}>Power and water updates for your suburb.</Text>
          <Text style={styles.copy}>See reported interruptions and the latest updates.</Text>
          <View style={styles.markRow}>
            <StatusIcon name="location" tone="plan" size={44} />
          </View>
          <PrimaryButton label="Choose my suburb" icon="search" onPress={() => router.push({ pathname: '/outages/search', params: { pick: 'area' } })} />
          <SecondaryButton label={locating ? 'Finding a suburb…' : 'Use my location'} icon="location" busy={locating} onPress={chooseByLocation} />
          <Text style={styles.reason}>We use your location once to suggest a suburb. Confirm it before it is saved.</Text>
          {suggestion && (
            <View style={styles.suggest}>
              <Text style={styles.suggestTitle}>Use {suggestion.name}?</Text>
              <Text style={styles.reason}>This is the nearest tracked suburb, not a confirmed street address.</Text>
              <PrimaryButton label="Save this suburb" onPress={() => { setSuburb(suggestion); setSuggestion(null); }} />
              <SecondaryButton label="Choose a different suburb" onPress={() => router.push({ pathname: '/outages/search', params: { pick: 'area' } })} />
            </View>
          )}
          {note && <Banner tone="warning">{note}</Banner>}
        </View>
      )}
      {suburb && (
        <View style={styles.stack}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Change suburb, ${suburb.name}`} onPress={() => router.push({ pathname: '/outages/search', params: { pick: 'area' } })} style={styles.placeRow}>
            <Ionicons name="location" size={22} color={colors.power} />
            <Text style={styles.suburb} accessibilityRole="header">{suburb.name}</Text>
          </Pressable>
          <View style={styles.fresh}>
            <Text style={styles.updated}>{updatedAt ? `Feeds checked ${relativeTime(updatedAt)}` : 'Feed time unavailable'}</Text>
            <Text style={styles.change} accessibilityRole="button" onPress={() => router.push({ pathname: '/outages/search', params: { pick: 'area' } })}>Change suburb</Text>
          </View>
          {savedBanner && <Banner tone="warning">Showing saved status.</Banner>}
          <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/suburb/[id]', params: { id: suburb.id } })} style={styles.statusWell}>
            <StatusRow service="ELECTRICITY" state={power} />
            <StatusRow service="WATER" state={water} />
          </Pressable>
          <Text style={styles.section}>Latest incidents{listed.length ? ` · ${listed.length}` : ''}</Text>
          {power.kind === 'loading' && water.kind === 'loading' && <OutageListSkeleton rows={2} />}
          {power.kind !== 'loading' && water.kind !== 'loading' && listed.length === 0 && power.kind === 'ok' && water.kind === 'ok' && (
            <Text style={styles.copy}>No current notices name this suburb. That is not confirmation that supply is normal.</Text>
          )}
          {listed.map((outage) => <OutageRow key={`${outage.service}:${outage.id}`} outage={outage} showService />)}
          <Text style={styles.reason}>A notice only covers the suburbs it names. Equipment nearby can still be affected.</Text>
        </View>
      )}
    </ScrollView>
  );
}

function StatusRow({ service, state }: { service: 'ELECTRICITY' | 'WATER'; state: ServiceState }) {
  const accent = serviceColor(service);
  const icon = service === 'WATER' ? 'water' : 'bolt';
  if (state.kind === 'loading') {
    return <View style={styles.row}><StatusIcon name="clock" tone="idle" size={36} /><View style={styles.rowCopy}><Text style={[styles.service, { color: accent }]}>{serviceLabel(service)}</Text><Text style={styles.cardLong}>Checking…</Text></View></View>;
  }
  if (state.kind !== 'ok') {
    return <View style={styles.row}><StatusIcon name="alert" tone="idle" size={36} /><View style={styles.rowCopy}><Text style={[styles.service, { color: accent }]}>{serviceLabel(service)}</Text><Text style={styles.cardLabel}>Unavailable</Text></View></View>;
  }
  const meta = areaHeadline(state.rows, service);
  return (
    <View style={styles.row}>
      <StatusIcon name={state.stale ? 'clock' : icon === 'bolt' ? 'flash' : icon} tone={meta.tone} size={36} />
      <View style={styles.rowCopy}>
        <Text style={[styles.service, { color: accent }]}>{serviceLabel(service)}{state.stale ? ` · ${savedAgeLabel(state.savedAt)}` : ''}</Text>
        <Text style={[styles.cardLabel, { color: toneColor(meta.tone) }]}>{meta.label}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { ...reading, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 36, gap: 18, backgroundColor: colors.page },
  title: { color: colors.text, fontFamily: font.bold, fontSize: 30, lineHeight: 36 },
  stack: { gap: 14 },
  copy: { color: colors.muted, fontFamily: font.text, fontSize: 16, lineHeight: 23 },
  reason: { color: colors.muted, fontFamily: font.text, fontSize: 14, lineHeight: 20 },
  markRow: { alignItems: 'flex-start' },
  suggest: { gap: 10, backgroundColor: colors.card, borderRadius: 16, padding: 14 },
  suggestTitle: { color: colors.text, fontFamily: font.bold, fontSize: 20 },
  placeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  suburb: { flex: 1, flexShrink: 1, color: colors.text, fontFamily: font.bold, fontSize: 34, lineHeight: 40 },
  fresh: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  updated: { color: colors.faint, fontFamily: font.mono, fontSize: 12, flex: 1 },
  change: { color: colors.power, fontFamily: font.semibold, fontSize: 15, minHeight: 48, textAlignVertical: 'center', paddingVertical: 12 },
  statusWell: { backgroundColor: colors.card, borderRadius: 16, paddingVertical: 4 },
  row: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 8 },
  rowCopy: { flex: 1, gap: 2 },
  service: { fontFamily: font.semibold, fontSize: 12, letterSpacing: 0.6 },
  cardLabel: { fontFamily: font.bold, fontSize: 18, lineHeight: 24 },
  cardLong: { color: colors.muted, fontFamily: font.text, fontSize: 14, lineHeight: 20 },
  section: { color: colors.text, fontFamily: font.bold, fontSize: 20, lineHeight: 26 },
});
