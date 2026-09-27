import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, ApiError, type MapOutage } from '@/src/lib/api';
import { sameService } from '@/src/lib/query.js';
import { statusMeta } from '@/src/lib/status.js';
import { Pill, ServiceSwitch, StatusIcon } from '@/src/components/ui';
import { useApp } from '@/src/state/app';
import { colors, font, toneColor } from '@/src/theme';
import { MapCanvas, selectionSentence, type Selection } from '@/src/components/MapCanvas';

export default function MapScreen() {
  const { service } = useApp();
  const router = useRouter();
  const [outages, setOutages] = useState<MapOutage[]>([]);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nativeMap, setNativeMap] = useState(Platform.OS !== 'web');

  const load = useCallback(async () => {
    setError(null);
    setSelected(null);
    try {
      const result = await api.map(service);
      setOutages(sameService(result.data, service));
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'offline' ? 'No connection.' : 'The map could not be loaded.');
    }
  }, [service]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const unavailable = useCallback(() => setNativeMap(false), []);
  const sentence = selected ? selectionSentence(selected) : null;

  return (
    <View style={styles.screen}>
      <View style={styles.switch}><ServiceSwitch /></View>
      {nativeMap ? (
        <MapBoundary onError={unavailable}>
          <MapCanvas outages={outages} onSelect={setSelected} onUnavailable={unavailable} />
        </MapBoundary>
      ) : (
        <ScrollView contentContainerStyle={styles.fallback}>
          <Text style={styles.note}>The map canvas needs a GridWatch development build. Areas below still open the incident.</Text>
          {placesOf(outages).map((place) => (
            <Pressable key={`${place.outageId}:${place.name}`} style={styles.place} onPress={() => setSelected(place)}>
              <Text style={styles.placeName}>{place.name}</Text>
              <Text style={{ color: toneColor(statusMeta(place.status, place.service, place.waterState).tone) }}>{statusMeta(place.status, place.service, place.waterState).label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <View style={styles.legend} pointerEvents="none">
        <LegendDot color={colors.live} label="Live" />
        <LegendDot color={colors.partial} label="Limited" />
        <LegendDot color={colors.plan} label="Planned" />
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      {selected && sentence && (
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.sheetKicker}>{selected.title}</Text>
          <Text style={styles.sheetPlace}>{selected.name}</Text>
          <View style={styles.sheetRow}>
            <StatusIcon name={sentence.icon} tone={sentence.tone} />
            <View style={styles.sheetCopy}>
              <Pill label={sentence.label} tone={sentence.tone} />
              <Text style={styles.sheetLong}>{sentence.long}</Text>
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            style={styles.see}
            onPress={() => router.push({ pathname: '/outage/[id]', params: { id: selected.outageId } })}
          >
            <Ionicons name="chevron-forward" size={18} color="#1a1408" />
            <Text style={styles.seeLabel}>See incident</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function MapBoundary({ children, onError }: { children: ReactNode; onError: () => void }) {
  return <MapBoundaryInner onError={onError}>{children}</MapBoundaryInner>;
}

class MapBoundaryInner extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

function placesOf(outages: MapOutage[]): Selection[] {
  const rows: Selection[] = [];
  for (const outage of outages) {
    for (const place of outage.places ?? []) {
      rows.push({
        outageId: outage.id,
        title: outage.title,
        name: place.name,
        status: outage.status,
        service: outage.service === 'WATER' ? 'WATER' : 'ELECTRICITY',
        waterState: outage.waterState,
      });
    }
  }
  return rows;
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  switch: { paddingHorizontal: 16, paddingBottom: 8 },
  fallback: { padding: 20, gap: 8 },
  note: { color: colors.muted, fontFamily: font.text, fontSize: 15, lineHeight: 22, marginBottom: 8 },
  place: { minHeight: 64, justifyContent: 'center', backgroundColor: colors.card, borderRadius: 16, paddingHorizontal: 14, marginBottom: 8, borderWidth: 1, borderColor: colors.line },
  placeName: { color: colors.text, fontFamily: font.semibold, fontSize: 16 },
  legend: { position: 'absolute', top: 72, left: 16, backgroundColor: 'rgba(9,11,14,0.92)', borderRadius: 16, paddingVertical: 10, paddingHorizontal: 12, gap: 8, borderWidth: 1, borderColor: colors.line },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { color: colors.text, fontFamily: font.semibold, fontSize: 12 },
  error: { position: 'absolute', top: 72, left: 16, right: 16, color: colors.text, fontFamily: font.text },
  sheet: { position: 'absolute', left: 12, right: 12, bottom: 12, backgroundColor: colors.card, borderRadius: 24, padding: 18, gap: 12, borderWidth: 1, borderColor: colors.line },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.line },
  sheetKicker: { color: colors.faint, fontFamily: font.text, fontSize: 13 },
  sheetPlace: { color: colors.text, fontFamily: font.bold, fontSize: 24, letterSpacing: -0.4 },
  sheetRow: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  sheetCopy: { flex: 1, gap: 6 },
  sheetLong: { color: colors.muted, fontFamily: font.text, fontSize: 14, lineHeight: 20 },
  see: { minHeight: 52, borderRadius: 16, backgroundColor: colors.power, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  seeLabel: { color: '#1a1408', fontFamily: font.bold, fontSize: 16 },
});
