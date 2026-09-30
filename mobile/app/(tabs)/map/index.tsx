import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, ApiError, type MapOutage } from '@/src/lib/api';
import { relativeTime } from '@/src/lib/time.js';
import { sameService } from '@/src/lib/query.js';
import { Pill, ServiceSwitch, StatusIcon } from '@/src/components/ui';
import { useApp } from '@/src/state/app';
import { colors, font, toneColor } from '@/src/theme';
import { MapCanvas, selectionSentence, type CameraCommand, type Selection } from '@/src/components/MapCanvas';
import { frameForPlaces, MAP_LAYERS, mapLayerFor, uniqueSelections, visiblePlaces } from '@/src/lib/geo.js';

const CITY: [number, number] = [28.0473, -26.2041];

export default function MapScreen() {
  const { service, suburb } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [outages, setOutages] = useState<MapOutage[]>([]);
  const [choices, setChoices] = useState<Selection[]>([]);
  const [choice, setChoice] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nativeMap, setNativeMap] = useState(Platform.OS !== 'web');
  const [layersOpen, setLayersOpen] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [command, setCommand] = useState<CameraCommand | null>(null);
  const [layers, setLayers] = useState<Record<string, boolean>>(() => Object.fromEntries(MAP_LAYERS.map((layer) => [layer.id, true])));
  const generation = useRef(0);
  const commandId = useRef(0);
  const locate = useRef(0);
  const serviceRef = useRef(service);
  const shown = visiblePlaces(outages, layers);
  const allHidden = MAP_LAYERS.every((layer) => layers[layer.id] === false);
  const filtersHideData = !allHidden && outages.length > 0 && shown.length === 0;
  const resetLayers = () => setLayers(Object.fromEntries(MAP_LAYERS.map((layer) => [layer.id, true])));
  const duration = reduceMotion ? 0 : 450;

  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (live) setReduceMotion(value);
    }).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);

  const move = (next: { kind: 'fit'; bounds: [number, number, number, number] } | { kind: 'center'; center: [number, number]; zoom: number }) => {
    commandId.current += 1;
    setCommand({ ...next, id: commandId.current, duration });
  };

  const load = useCallback(async (mode?: 'refresh') => {
    const token = ++generation.current;
    const requested = service;
    setError(null);
    setLoading(mode !== 'refresh');
    setChoices([]);
    if (mode !== 'refresh') setOutages([]);
    if (locate) locate.current += 1;
    try {
      const result = await api.map(requested);
      if (token !== generation.current) return;
      if (serviceRef && requested !== serviceRef.current) return;
      setOutages(sameService(result.data, requested));
    } catch (err) {
      if (token !== generation.current) return;
      if (serviceRef && requested !== serviceRef.current) return;
      if (mode !== 'refresh') setOutages([]);
      setError(err instanceof ApiError && err.code === 'offline' ? 'No connection.' : 'The map could not be loaded.');
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    serviceRef.current = service;
  }, [service]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const unavailable = useCallback(() => setNativeMap(false), []);
  const selected = choices[choice] ?? null;
  const sentence = selected ? selectionSentence(selected) : null;

  const showMine = async () => {
    if (!suburb || !nativeMap) return;
    const token = ++locate.current;
    const requested = service;
    try {
      const found = await api.search(suburb.name, requested);
      if (token !== locate.current || requested !== serviceRef.current) return;
      const match = found.suburbs.find((item) => item.id === suburb.id && item.lat != null && item.lon != null);
      if (match?.lon != null && match.lat != null) {
        setError(null);
        move({ kind: 'center', center: [match.lon, match.lat], zoom: 12 });
        return;
      }
      setError('This suburb has no map point yet.');
    } catch {
      if (token !== locate.current || requested !== serviceRef.current) return;
      setError('My area could not be located on the map.');
    }
  };

  const showAll = () => {
    if (!nativeMap) return;
    setChoices([]);
    const frame = frameForPlaces(shown);
    if (!frame) move({ kind: 'center', center: CITY, zoom: 9 });
    else if (frame.kind === 'fit') move({ kind: 'fit', bounds: frame.bounds as [number, number, number, number] });
    else move({ kind: 'center', center: frame.center as [number, number], zoom: frame.zoom ?? 13 });
  };

  const pick = (items: Selection[]) => {
    const unique = uniqueSelections(items) as Selection[];
    setChoices(unique);
    setChoice(0);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.switch}>
        <ServiceSwitch />
        <View style={styles.tools}>
          {nativeMap && suburb && <Pressable accessibilityRole="button" onPress={showMine} style={styles.tool}><Text style={styles.toolLabel}>Show my area</Text></Pressable>}
          {nativeMap && <Pressable accessibilityRole="button" onPress={showAll} style={styles.tool}><Text style={styles.toolLabel}>Show all</Text></Pressable>}
          {error && <Pressable accessibilityRole="button" onPress={() => load()} style={styles.tool}><Text style={styles.toolLabel}>Retry</Text></Pressable>}
        </View>
        {error && !selected && <Text style={styles.error}>{error}</Text>}
      </View>
      {loading && <Text style={styles.loading}>Loading areas…</Text>}
      {nativeMap ? (
        <View style={styles.stage}>
          <MapBoundary onError={unavailable}>
            <MapCanvas outages={shown} command={command} onSelect={pick} onUnavailable={unavailable} />
          </MapBoundary>
          {!selected && (
            <View style={styles.layers}>
              <Pressable accessibilityRole="button" accessibilityLabel="Layers" onPress={() => setLayersOpen((open) => !open)} style={styles.tool}>
                <Text style={styles.toolLabel}>{layersOpen ? 'Hide layers' : 'Layers'}</Text>
              </Pressable>
              {layersOpen && MAP_LAYERS.map((layer) => (
                <LegendDot
                  key={layer.id}
                  color={toneColor(layer.tone)}
                  label={layer.label}
                  on={layers[layer.id] !== false}
                  onPress={() => {
                    const next = { ...layers, [layer.id]: layers[layer.id] === false };
                    setLayers(next);
                    setChoices((items) => items.filter((item) => next[mapLayerFor(item, item)] !== false));
                    setChoice(0);
                  }}
                />
              ))}
            </View>
          )}
          {!loading && allHidden && <Text style={[styles.mapNote, styles.mapNoteRaised]}>All layers are hidden.</Text>}
          {!loading && filtersHideData && <Text style={[styles.mapNote, styles.mapNoteRaised]}>No incidents match these layers.</Text>}
          {!loading && !error && !allHidden && !filtersHideData && shown.length === 0 && <Text style={styles.mapNote}>No incidents to show.</Text>}
          {!loading && (allHidden || filtersHideData) && (
            <Pressable accessibilityRole="button" onPress={resetLayers} style={styles.reset}>
              <Text style={styles.toolLabel}>Reset layers</Text>
            </Pressable>
          )}
          {selected && sentence && (
            <View style={[styles.sheet, { marginBottom: Math.max(insets.bottom, 12) }]}>
              <ScrollView contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
                <View style={styles.sheetHead}>
                  <Text style={styles.sheetPlace}>{selected.name}</Text>
                  <Pressable accessibilityRole="button" accessibilityLabel="Close place" onPress={() => setChoices([])} style={styles.close}><Text style={styles.closeLabel}>Close</Text></Pressable>
                </View>
                <Text style={styles.sheetKicker}>{selected.inferred ? 'Possible impact' : 'Named in the notice'} · {selected.title}</Text>
                <View style={styles.sheetRow}>
                  <StatusIcon name={sentence.icon} tone={sentence.tone} />
                  <View style={styles.sheetCopy}>
                    <Pill label={sentence.label} tone={sentence.tone} />
                    <Text style={styles.sheetLong}>{sentence.long}</Text>
                    <Text style={styles.sheetKicker}>{selected.updatedAt ? `Updated ${relativeTime(selected.updatedAt)}` : 'Update time unknown'}</Text>
                  </View>
                </View>
                {choices.length > 1 && (
                  <View style={styles.choices}>
                    {choices.map((item, index) => (
                      <Pressable key={`${item.outageId}:${item.placeId}`} accessibilityRole="button" onPress={() => setChoice(index)} style={styles.tool}>
                        <Text style={styles.toolLabel}>{index === choice ? 'Selected' : 'Choose'} {item.title}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
                <Pressable accessibilityRole="button" style={[styles.see, { backgroundColor: selected.service === 'WATER' ? colors.water : colors.power }]} onPress={() => router.push({ pathname: '/outage/[id]', params: { id: selected.outageId } })}>
                  <Ionicons name="chevron-forward" size={18} color="#1a1408" />
                  <Text style={styles.seeLabel}>View incident</Text>
                </Pressable>
              </ScrollView>
            </View>
          )}
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.fallback}>
          <Text style={styles.note}>Map unavailable. Browse affected areas below.</Text>
          <View style={styles.flowLayers}>
            {MAP_LAYERS.map((layer) => (
              <LegendDot
                key={layer.id}
                color={toneColor(layer.tone)}
                label={layer.label}
                on={layers[layer.id] !== false}
                onPress={() => {
                  const next = { ...layers, [layer.id]: layers[layer.id] === false };
                  setLayers(next);
                  setChoices((items) => items.filter((item) => next[mapLayerFor(item, item)] !== false));
                  setChoice(0);
                }}
              />
            ))}
          </View>
          {(allHidden || filtersHideData) && <Pressable accessibilityRole="button" onPress={resetLayers} style={styles.tool}><Text style={styles.toolLabel}>Reset layers</Text></Pressable>}
          {allHidden && <Text style={styles.note}>All layers are hidden.</Text>}
          {filtersHideData && !loading && <Text style={styles.note}>No incidents match these layers.</Text>}
          {!allHidden && !filtersHideData && !error && placesOf(shown).length === 0 && !loading && <Text style={styles.note}>No incidents to show.</Text>}
          {placesOf(shown).map((place) => (
            <Pressable key={`${place.outageId}:${place.placeId}:${place.name}`} style={styles.place} onPress={() => pick([place])}>
              <Text style={styles.placeName}>{place.name}</Text>
              <Text style={{ color: toneColor(selectionSentence(place).tone) }}>{selectionSentence(place).label}</Text>
            </Pressable>
          ))}
          {selected && sentence && (
            <View style={styles.fallbackSheet}>
              <Text style={styles.sheetPlace}>{selected.name}</Text>
              <Text style={styles.sheetKicker}>{sentence.label}</Text>
              <Pressable accessibilityRole="button" style={[styles.see, { backgroundColor: selected.service === 'WATER' ? colors.water : colors.power }]} onPress={() => router.push({ pathname: '/outage/[id]', params: { id: selected.outageId } })}>
                <Text style={styles.seeLabel}>View incident</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
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
        placeId: place.id,
        title: outage.title,
        name: place.name,
        status: outage.status,
        service: outage.service === 'WATER' ? 'WATER' : 'ELECTRICITY',
        waterState: outage.waterState,
        restored: Boolean(place.restored),
        inferred: Boolean(place.inferred),
        updatedAt: outage.lastUpdateAt,
      });
    }
  }
  return rows;
}

function LegendDot({ color, label, on, onPress }: { color: string; label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={`${label}, ${on ? 'shown' : 'hidden'}`}
      onPress={onPress}
      style={[styles.legendItem, !on && styles.legendOff]}
    >
      <View style={[styles.dot, { backgroundColor: on ? color : 'transparent', borderColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  switch: { paddingHorizontal: 16, paddingBottom: 8, gap: 8 },
  tools: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tool: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12, backgroundColor: colors.card },
  toolLabel: { color: colors.text, fontFamily: font.semibold, fontSize: 14 },
  loading: { color: colors.muted, fontFamily: font.text, paddingHorizontal: 16, paddingBottom: 8 },
  choices: { gap: 8 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  close: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  closeLabel: { color: colors.power, fontFamily: font.semibold, fontSize: 15 },
  fallback: { padding: 20, gap: 8 },
  note: { color: colors.muted, fontFamily: font.text, fontSize: 15, lineHeight: 22, marginBottom: 8 },
  place: { minHeight: 64, justifyContent: 'center', backgroundColor: colors.card, borderRadius: 16, paddingHorizontal: 14, marginBottom: 8, borderWidth: 1, borderColor: colors.line },
  placeName: { color: colors.text, fontFamily: font.semibold, fontSize: 16 },
  stage: { flex: 1 },
  layers: { position: 'absolute', top: 12, left: 12, gap: 4, maxWidth: '70%' },
  flowLayers: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  mapNote: { position: 'absolute', left: 16, right: 16, bottom: 16, color: colors.text, fontFamily: font.text, fontSize: 15, lineHeight: 21 },
  mapNoteRaised: { bottom: 108 },
  reset: { position: 'absolute', left: 16, bottom: 48, minHeight: 48, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12, backgroundColor: colors.card },
  fallbackSheet: { gap: 8, marginTop: 8 },
  sheetBody: { gap: 12 },
  legendItem: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, borderRadius: 12, backgroundColor: 'rgba(9,11,14,0.92)' },
  legendOff: { opacity: 0.4 },
  dot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5 },
  legendLabel: { color: colors.text, fontFamily: font.semibold, fontSize: 12 },
  error: { color: colors.text, fontFamily: font.text, fontSize: 14, lineHeight: 20 },
  sheet: { position: 'absolute', left: 12, right: 12, bottom: 12, maxHeight: '52%', backgroundColor: colors.cardRaised, borderRadius: 24, padding: 18 },
  sheetKicker: { color: colors.faint, fontFamily: font.text, fontSize: 13, flexShrink: 1 },
  sheetPlace: { flex: 1, flexShrink: 1, color: colors.text, fontFamily: font.bold, fontSize: 24, letterSpacing: -0.4 },
  sheetRow: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  sheetCopy: { flex: 1, gap: 6 },
  sheetLong: { color: colors.muted, fontFamily: font.text, fontSize: 14, lineHeight: 20 },
  see: { minHeight: 52, borderRadius: 16, backgroundColor: colors.power, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  seeLabel: { color: '#1a1408', fontFamily: font.bold, fontSize: 16 },
});
