import { Stack } from 'expo-router/js-stack';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, findNodeHandle, FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { api, ApiError, type Outage } from '@/src/lib/api';
import { appendAllowed, mergeOutagePage, outageQueryKey, pageStillCurrent } from '@/src/lib/outage-list.js';
import { relativeTime } from '@/src/lib/time.js';
import { sameService } from '@/src/lib/query.js';
import { Banner, OutageListSkeleton, OutageRow, PrimaryButton, SecondaryButton, ServiceSwitch, StatusIcon } from '@/src/components/ui';
import { useApp } from '@/src/state/app';
import { colors, font, reading, serviceColor, serviceLabel } from '@/src/theme';

const PAGE = 30;
const ALL = 'ACTIVE,PARTIALLY_RESTORED,PLANNED,RESTORED,STALE,CLOSED,CANCELLED';

const PRIMARY = [
  { id: 'live', label: 'Active', status: 'ACTIVE,PARTIALLY_RESTORED', count: (c: Record<string, number>) => (c.ACTIVE ?? 0) + (c.PARTIALLY_RESTORED ?? 0) },
  { id: 'planned', label: 'Planned', status: 'PLANNED', count: (c: Record<string, number>) => c.PLANNED ?? 0 },
  { id: 'finished', label: 'Finished', status: 'RESTORED,CLOSED,CANCELLED', count: (c: Record<string, number>) => (c.RESTORED ?? 0) + (c.CLOSED ?? 0) + (c.CANCELLED ?? 0) },
] as const;

const MORE = [
  { id: 'quiet', label: 'No recent update', status: 'STALE', count: (c: Record<string, number>) => c.STALE ?? 0 },
  { id: 'all', label: 'All', status: ALL, count: (c: Record<string, number>) => Object.values(c).reduce((sum, n) => sum + n, 0) },
] as const;

const STATUSES = [...PRIMARY, ...MORE];
const SORTS = [
  { id: 'updated', label: 'Recently updated' },
  { id: 'started', label: 'Newest first' },
  { id: 'name', label: 'Name A–Z' },
] as const;

type StatusId = (typeof STATUSES)[number]['id'];
type SortId = (typeof SORTS)[number]['id'];

export default function OutagesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { service } = useApp();
  const accent = serviceColor(service);
  const [rows, setRows] = useState<Outage[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusId, setStatusId] = useState<StatusId>('live');
  const [sort, setSort] = useState<SortId>('updated');
  const [sdc, setSdc] = useState('');
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [centres, setCentres] = useState<{ sdc: string; count: number }[]>([]);
  const [sheet, setSheet] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [draftSort, setDraftSort] = useState<SortId>('updated');
  const [draftSdc, setDraftSdc] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [explain, setExplain] = useState(false);
  const shownAt = useRef<number | null>(null);
  const active = useRef({ key: '', seq: 0 });
  const paging = useRef(false);
  const replacing = useRef(false);
  const serviceRef = useRef(service);
  const rowsRef = useRef(rows);
  const filterButton = useRef<View>(null);

  const status = STATUSES.find((item) => item.id === statusId) ?? STATUSES[0];
  const centre = service === 'ELECTRICITY' ? sdc : '';
  const filterCount = (sort === 'updated' ? 0 : 1) + (centre ? 1 : 0);
  const filtered = statusId !== 'live' || filterCount > 0 || q !== '';

  useEffect(() => {
    serviceRef.current = service;
  }, [service]);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    const timer = setTimeout(() => setQ(draft.trim()), 300);
    return () => clearTimeout(timer);
  }, [draft]);

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

  useEffect(() => {
    setSdc('');
  }, [service]);

  const loadStats = useCallback(async () => {
    const requested = service;
    try {
      const result = await api.stats(requested);
      if (requested !== serviceRef.current) return;
      setCounts(result.outagesByStatus ?? {});
      setCentres((result.activeBySdc ?? []).filter((item) => item.sdc).sort((a, b) => a.sdc.localeCompare(b.sdc)));
    } catch {
      if (requested !== serviceRef.current) return;
      setCounts(null);
      setCentres([]);
    }
  }, [service]);

  const load = useCallback(async (mode: 'replace' | 'refresh' | 'append') => {
    const key = outageQueryKey({ service, status: status.status, sort, q, centre });
    if (mode === 'append') {
      if (!appendAllowed({ reload: replacing.current, paging: paging.current }) || active.current.key !== key) return;
    } else {
      active.current = { key, seq: active.current.seq + 1 };
      paging.current = false;
      replacing.current = true;
      if (mode === 'replace') {
        rowsRef.current = [];
        setRows([]);
        setTotal(0);
        setCounts(null);
      }
      setLoading(mode !== 'refresh');
    }
    const request = { ...active.current };
    const offset = mode === 'append' ? rowsRef.current.length : 0;
    if (mode === 'append') {
      paging.current = true;
      setLoadingMore(true);
    }
    setError(null);
    try {
      const result = await api.outages(service, {
        status: status.status,
        sort,
        q: q || undefined,
        sdc: centre || undefined,
        limit: PAGE,
        offset,
      });
      if (!pageStillCurrent(request, active.current)) return;
      const next = sameService(result.data, service);
      setRows((current) => {
        const merged = mergeOutagePage(current, next, mode !== 'append');
        rowsRef.current = merged;
        return merged;
      });
      setTotal(result.total);
      shownAt.current = Date.now();
    } catch (err) {
      if (!pageStillCurrent(request, active.current)) return;
      const offline = err instanceof ApiError && err.code === 'offline';
      if (mode === 'refresh') {
        const age = shownAt.current ? ` Showing the list from ${relativeTime(new Date(shownAt.current).toISOString())}.` : ' Showing the list already on screen.';
        setError(`${offline ? 'No connection.' : 'Could not refresh.'}${age}`);
      } else if (mode !== 'append') {
        rowsRef.current = [];
        setRows([]);
        setTotal(0);
        setError(offline ? 'No connection.' : 'Outages could not be loaded.');
      } else {
        setError(offline ? 'No connection.' : 'More incidents could not be loaded.');
      }
    } finally {
      if (pageStillCurrent(request, active.current)) {
        paging.current = false;
        replacing.current = false;
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
      }
    }
  }, [service, status.status, sort, q, centre]);

  useEffect(() => {
    load('replace').catch(() => undefined);
    loadStats().catch(() => undefined);
  }, [load, loadStats]);

  const openSheet = () => {
    setDraftSort(sort);
    setDraftSdc(centre);
    setSheet(true);
  };

  const closeSheet = () => {
    setSheet(false);
    setTimeout(() => {
      const node = filterButton.current ? findNodeHandle(filterButton.current) : null;
      if (node) AccessibilityInfo.setAccessibilityFocus(node);
    }, 300);
  };

  const filterLabel = filterCount ? `Filters ${filterCount}` : 'Filters';

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{
        title: 'Outages',
        headerRight: () => (
          <Pressable accessibilityRole="button" accessibilityLabel="Browse suburbs" onPress={() => router.push('/outages/search')} style={styles.browse}>
            <Text style={styles.filterLabel}>Suburbs</Text>
          </Pressable>
        ),
      }} />
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.content}
        data={loading && rows.length === 0 ? [] : rows}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load('refresh').catch(() => undefined); loadStats().catch(() => undefined); }} tintColor={accent} />}
        ListHeaderComponent={(
          <View style={styles.header}>
            <ServiceSwitch />
            <View style={styles.searchRow}>
              <View style={styles.field}>
                <Ionicons name="search" size={18} color={colors.faint} />
                <TextInput
                  value={draft}
                  onChangeText={setDraft}
                  placeholder="Suburb or equipment"
                  placeholderTextColor={colors.faint}
                  autoCapitalize="words"
                  autoCorrect={false}
                  style={styles.input}
                  accessibilityLabel="Filter by suburb or equipment"
                />
                {draft.length > 0 && (
                  <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => { setDraft(''); setQ(''); }} hitSlop={8}>
                    <Ionicons name="close-circle" size={18} color={colors.faint} />
                  </Pressable>
                )}
              </View>
              <Pressable ref={filterButton} accessibilityRole="button" accessibilityLabel={filterLabel} onPress={openSheet} style={styles.filterButton}>
                <Ionicons name="options" size={18} color={colors.text} />
                <Text style={styles.filterLabel} numberOfLines={1}>{filterLabel}</Text>
              </Pressable>
            </View>
            {centre ? <Text style={styles.appliedChip}>{prettyCentre(centre)}</Text> : null}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {PRIMARY.map((item) => (
                <Chip key={item.id} label={counts ? `${item.label} ${item.count(counts)}` : item.label} selected={statusId === item.id} accent={accent} onPress={() => { setStatusId(item.id); setMoreOpen(false); }} />
              ))}
              <Chip label="More" selected={moreOpen || MORE.some((item) => item.id === statusId)} accent={accent} onPress={() => setMoreOpen((open) => !open)} />
            </ScrollView>
            {moreOpen && (
              <View style={styles.chips}>
                {MORE.map((item) => (
                  <Chip key={item.id} label={counts ? `${item.label} ${item.count(counts)}` : item.label} selected={statusId === item.id} accent={accent} onPress={() => setStatusId(item.id)} />
                ))}
              </View>
            )}
            <Text style={styles.lede}>
              {loading && rows.length === 0 ? 'Loading incidents…' : total === 0 ? 'No incidents match' : `Showing ${rows.length} of ${total}`}
              {q ? ` for “${q}”` : ''}
            </Text>
            <View style={styles.noteRow}>
              <Text style={styles.note}>{statusId === 'finished' ? 'Finished includes restored, closed, and cancelled.' : 'Counts cover every incident, not only this search.'}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="About these counts" onPress={() => setExplain(true)} hitSlop={8}>
                <Ionicons name="information-circle-outline" size={20} color={colors.muted} />
              </Pressable>
            </View>
            {error && <Banner tone="error" action={{ label: 'Retry', onPress: () => { load('replace').catch(() => undefined); loadStats().catch(() => undefined); } }}>{error}</Banner>}
          </View>
        )}
        ListEmptyComponent={loading ? <OutageListSkeleton /> : error ? null : (
          <View style={styles.empty}>
            <StatusIcon name="check" tone="idle" />
            <Text style={styles.emptyTitle}>{filtered ? 'Nothing matches these filters' : `No ${status.label.toLowerCase()} incidents`}</Text>
            {filtered && <SecondaryButton label="Reset filters" onPress={() => { setStatusId('live'); setSort('updated'); setSdc(''); setDraft(''); setQ(''); }} />}
          </View>
        )}
        ListFooterComponent={!loading && !refreshing && rows.length > 0 && rows.length < total ? (
          <View style={styles.more}>{loadingMore ? <ActivityIndicator color={accent} /> : <SecondaryButton label="Show more" onPress={() => load('append')} />}</View>
        ) : null}
        renderItem={({ item }) => <OutageRow outage={item} />}
      />
      <Modal visible={sheet} animationType={reduceMotion ? 'none' : 'slide'} transparent onRequestClose={closeSheet}>
        <View style={styles.modal}>
        <Pressable style={styles.backdrop} onPress={closeSheet} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>Filters</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close filters" onPress={closeSheet} style={styles.close}>
              <Text style={styles.filterLabel}>Close</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.sheetLabel}>Sort</Text>
            <View style={styles.chips}>
              {SORTS.map((item) => (
                <Chip key={item.id} label={item.label} selected={draftSort === item.id} accent={accent} onPress={() => setDraftSort(item.id)} />
              ))}
            </View>
            {service === 'ELECTRICITY' && (
              <>
                <Text style={styles.sheetLabel}>Service centre</Text>
                <View style={styles.chips}>
                  <Chip label="All centres" selected={draftSdc === ''} accent={accent} onPress={() => setDraftSdc('')} />
                  {centres.map((item) => (
                    <Chip key={item.sdc} label={prettyCentre(item.sdc)} selected={draftSdc === item.sdc} accent={accent} onPress={() => setDraftSdc(item.sdc)} />
                  ))}
                </View>
              </>
            )}
            <SecondaryButton label="Reset" onPress={() => { setDraftSort('updated'); setDraftSdc(''); }} />
            <PrimaryButton label="Apply" onPress={() => { setSort(draftSort); setSdc(service === 'ELECTRICITY' ? draftSdc : ''); closeSheet(); }} />
          </ScrollView>
        </View>
        </View>
      </Modal>
      <Modal visible={explain} animationType={reduceMotion ? 'none' : 'fade'} transparent onRequestClose={() => setExplain(false)}>
        <View style={styles.modal}>
          <Pressable style={styles.backdrop} onPress={() => setExplain(false)} />
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>About these counts</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setExplain(false)} style={styles.close}>
                <Text style={styles.filterLabel}>Close</Text>
              </Pressable>
            </View>
            <Text style={styles.note}>Counts are for all {serviceLabel(service).toLowerCase()} incidents, not the current search. Finished includes restored, closed, and cancelled. Each row keeps its own status.</Text>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Chip({ label, selected, accent, onPress }: { label: string; selected: boolean; accent: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.chip, selected && { backgroundColor: accent, borderColor: accent }]}>
      <Text style={[styles.chipLabel, selected && styles.chipLabelOn]}>{label}</Text>
    </Pressable>
  );
}

function prettyCentre(name: string) {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2');
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  list: { flex: 1, backgroundColor: colors.page },
  content: { ...reading, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 32 },
  header: { gap: 12, marginBottom: 8 },
  searchRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  field: { flex: 1, minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.card, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 },
  input: { flex: 1, color: colors.text, fontFamily: font.text, fontSize: 16, paddingVertical: 10 },
  filterButton: { minHeight: 48, maxWidth: 112, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.lineStrong, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  appliedChip: { alignSelf: 'flex-start', color: colors.text, fontFamily: font.semibold, fontSize: 14, lineHeight: 20, flexShrink: 1 },
  filterLabel: { color: colors.text, fontFamily: font.semibold, fontSize: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 48, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.card, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  chipLabel: { color: colors.text, fontFamily: font.semibold, fontSize: 14, lineHeight: 18 },
  chipLabelOn: { color: '#1a1408' },
  lede: { color: colors.text, fontFamily: font.text, fontSize: 15, lineHeight: 21 },
  browse: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 8 },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  note: { flex: 1, color: colors.muted, fontFamily: font.text, fontSize: 13, lineHeight: 18 },
  spinner: { marginTop: 24 },
  empty: { gap: 8, paddingVertical: 12 },
  emptyTitle: { color: colors.text, fontFamily: font.semibold, fontSize: 17 },
  more: { paddingVertical: 8 },
  modal: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { maxHeight: '85%', backgroundColor: colors.cardRaised, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, gap: 12 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  sheetBody: { gap: 12, paddingBottom: 8 },
  close: { minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center' },
  sheetTitle: { color: colors.text, fontFamily: font.bold, fontSize: 22, flex: 1 },
  sheetLabel: { color: colors.muted, fontFamily: font.semibold, fontSize: 13 },
});
