import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { areaHeadline, sortOutages } from '@/src/lib/area.js';
import { api, ApiError, type Outage } from '@/src/lib/api';
import { nearestSuburb } from '@/src/lib/geo.js';
import { readCache, writeCache } from '@/src/lib/storage';
import { relativeTime } from '@/src/lib/time.js';
import { useApp } from '@/src/state/app';
import { Banner, Eyebrow, OutageRow, PrimaryButton, SecondaryButton, SectionTitle, StatusIcon, Wordmark } from '@/src/components/ui';
import { colors, font, serviceLabel, toneColor } from '@/src/theme';

type AreaPayload = {
  power: Outage[];
  water: Outage[];
  updatedAt: string | null;
};

export default function MyAreaScreen() {
  const router = useRouter();
  const { suburb, setSuburb } = useApp();
  const [payload, setPayload] = useState<AreaPayload | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setNote(null);
    try {
      const [power, water, sync] = await Promise.all([
        api.localityOutages(id, 'ELECTRICITY'),
        api.localityOutages(id, 'WATER'),
        api.sync(),
      ]);
      const next = { power: power.data, water: water.data, updatedAt: sync.lastSyncAt };
      setPayload(next);
      setStale(false);
      await writeCache(`area:${id}`, next);
    } catch (error) {
      const cached = await readCache<AreaPayload>(`area:${id}`);
      if (cached) {
        setPayload(cached.data);
        setStale(true);
      } else {
        setNote(error instanceof ApiError && error.code === 'offline' ? 'No connection, and no saved status yet.' : 'The status could not be loaded.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const chooseByLocation = async () => {
    setLocating(true);
    setNote(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setNote('Location is off. Choose a suburb by name instead.');
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
      setSuburb({ id: match.id, name: match.name });
    } catch {
      setNote('Location could not be read. Choose a suburb by name.');
    } finally {
      setLocating(false);
    }
  };

  useEffect(() => {
    if (!suburb) {
      setPayload(null);
      return;
    }
    setPayload(null);
    setStale(false);
    load(suburb.id).catch(() => undefined);
  }, [suburb, load]);

  const listed = payload ? sortOutages([...payload.power, ...payload.water]) : [];

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Wordmark />
      {!suburb && (
        <View style={styles.stack}>
          <Eyebrow>My area</Eyebrow>
          <Text style={styles.title}>Is my power or water affected?</Text>
          <Text style={styles.copy}>Save one suburb. Power and water are read separately, from the notices that name it.</Text>
          <View style={styles.intro}>
            <StatusIcon name="location" tone="plan" size={40} />
            <View style={styles.introCopy}>
              <Text style={styles.introTitle}>Your location stays on this phone</Text>
              <Text style={styles.reason}>It is used once, to match a suburb GridWatch already tracks. You can also choose the name yourself.</Text>
            </View>
          </View>
          <PrimaryButton label={locating ? 'Finding your suburb…' : 'Use my suburb'} icon="location" onPress={chooseByLocation} />
          <SecondaryButton label="Choose a suburb" icon="search" onPress={() => router.push({ pathname: '/outages/search', params: { pick: 'area' } })} />
          {note && <Banner>{note}</Banner>}
        </View>
      )}
      {suburb && (
        <View style={styles.stack}>
          <Eyebrow>Saved suburb</Eyebrow>
          <View style={styles.titleRow}>
            <Text style={styles.suburb}>{suburb.name}</Text>
          </View>
          <View style={styles.fresh}>
            <Text style={styles.updated}>
              {payload?.updatedAt ? `Feeds updated ${relativeTime(payload.updatedAt)}` : 'Feed time unknown'}
            </Text>
            <Text style={styles.change} onPress={() => router.push({ pathname: '/outages/search', params: { pick: 'area' } })}>Change</Text>
          </View>
          {stale && <Banner>Showing the last status saved on this phone.</Banner>}
          {note && <Banner>{note}</Banner>}
          {loading && !payload && <ActivityIndicator color={colors.power} />}
          {payload && (
            <>
              <View style={styles.pair}>
                <StatusCard service="ELECTRICITY" outages={payload.power} />
                <StatusCard service="WATER" outages={payload.water} />
              </View>
              <SectionTitle
                title="Named in a notice"
                detail={listed.length === 0 ? 'Nothing current lists this suburb.' : `${listed.length} current ${listed.length === 1 ? 'incident' : 'incidents'}`}
              />
              {listed.map((outage) => (
                <OutageRow key={`${outage.service}:${outage.id}`} outage={outage} showService />
              ))}
            </>
          )}
          <SecondaryButton label={loading ? 'Refreshing…' : 'Refresh'} icon="refresh" onPress={() => load(suburb.id)} />
        </View>
      )}
    </ScrollView>
  );
}

function StatusCard({ service, outages }: { service: 'ELECTRICITY' | 'WATER'; outages: Outage[] }) {
  const meta = areaHeadline(outages, service);
  const accent = service === 'WATER' ? colors.water : colors.power;
  return (
    <View style={styles.card}>
      <Text style={[styles.service, { color: accent }]}>{serviceLabel(service)}</Text>
      <StatusIcon name={meta.icon} tone={meta.tone} size={32} />
      <Text style={[styles.cardLabel, { color: toneColor(meta.tone) }]}>{meta.label}</Text>
      <Text style={styles.cardLong}>{meta.long}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 36, gap: 18, backgroundColor: colors.page },
  title: { color: colors.text, fontFamily: font.bold, fontSize: 32, lineHeight: 36, letterSpacing: -0.8 },
  stack: { gap: 14 },
  copy: { color: colors.muted, fontFamily: font.text, fontSize: 16, lineHeight: 23 },
  reason: { color: colors.muted, fontFamily: font.text, fontSize: 14, lineHeight: 20 },
  intro: { flexDirection: 'row', gap: 12, backgroundColor: colors.card, borderRadius: 18, padding: 14, borderWidth: 1, borderColor: colors.line },
  introCopy: { flex: 1, gap: 4 },
  introTitle: { color: colors.text, fontFamily: font.semibold, fontSize: 15 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start' },
  suburb: { color: colors.text, fontFamily: font.bold, fontSize: 34, lineHeight: 38, letterSpacing: -0.8, flex: 1 },
  fresh: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  updated: { color: colors.faint, fontFamily: font.mono, fontSize: 12 },
  change: { color: colors.power, fontFamily: font.semibold, fontSize: 14 },
  pair: { flexDirection: 'row', gap: 10 },
  card: { flex: 1, borderRadius: 18, padding: 14, gap: 8, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  service: { fontFamily: font.semibold, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase' },
  cardLabel: { color: colors.text, fontFamily: font.bold, fontSize: 16, lineHeight: 21 },
  cardLong: { color: colors.muted, fontFamily: font.text, fontSize: 13, lineHeight: 18 },
});
