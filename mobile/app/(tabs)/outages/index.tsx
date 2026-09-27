import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, ApiError, type Outage } from '@/src/lib/api';
import { sameService } from '@/src/lib/query.js';
import { Banner, Eyebrow, OutageRow, SecondaryButton, ServiceSwitch, StatusIcon } from '@/src/components/ui';
import { useApp } from '@/src/state/app';
import { colors, font, serviceLabel } from '@/src/theme';

const PAGE = 30;

const STATUSES = [
  { id: 'live', label: 'Live', status: 'ACTIVE,PARTIALLY_RESTORED', count: (c: Record<string, number>) => (c.ACTIVE ?? 0) + (c.PARTIALLY_RESTORED ?? 0) },
  { id: 'planned', label: 'Planned', status: 'PLANNED', count: (c: Record<string, number>) => c.PLANNED ?? 0 },
  { id: 'restored', label: 'Restored', status: 'RESTORED,CLOSED', count: (c: Record<string, number>) => (c.RESTORED ?? 0) + (c.CLOSED ?? 0) },
  { id: 'quiet', label: 'No update', status: 'STALE', count: (c: Record<string, number>) => c.STALE ?? 0 },
  { id: 'all', label: 'All', status: 'ACTIVE,PARTIALLY_RESTORED,PLANNED,RESTORED,STALE,CLOSED,CANCELLED', count: (c: Record<string, number>) => Object.values(c).reduce((sum, n) => sum + n, 0) },
] as const;

const SORTS = [
  { id: 'updated', label: 'Updated' },
  { id: 'started', label: 'Newest' },
  { id: 'name', label: 'Name' },
] as const;

type StatusId = (typeof STATUSES)[number]['id'];
type SortId = (typeof SORTS)[number]['id'];

export default function OutagesScreen() {
  const { service } = useApp();
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

  const accent = service === 'WATER' ? colors.water : colors.power;
  const status = STATUSES.find((item) => item.id === statusId) ?? STATUSES[0];
  const centre = service === 'ELECTRICITY' ? sdc : '';
  const filtered = statusId !== 'live' || sort !== 'updated' || centre !== '' || q !== '';

  useEffect(() => {
    const timer = setTimeout(() => setQ(draft.trim()), 300);
    return () => clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    setSdc('');
  }, [service]);

  const loadStats = useCallback(async () => {
    try {
      const result = await api.stats(service);
      setCounts(result.outagesByStatus ?? {});
      setCentres((result.activeBySdc ?? []).filter((item) => item.sdc).sort((a, b) => a.sdc.localeCompare(b.sdc)));
    } catch {
      setCounts(null);
      setCentres([]);
    }
  }, [service]);

  const load = useCallback(async (offset: number) => {
    if (offset === 0) setLoading(true);
    else setLoadingMore(true);
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
      const next = sameService(result.data, service);
      setRows((current) => (offset === 0 ? next : [...current, ...next]));
      setTotal(result.total);
    } catch (err) {
      if (offset === 0) setRows([]);
      setError(err instanceof ApiError && err.code === 'offline' ? 'No connection.' : 'Outages could not be loaded.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
      setRefreshing(false);
    }
  }, [service, status.status, sort, q, centre]);

  useEffect(() => {
    load(0).catch(() => undefined);
  }, [load]);

  useEffect(() => {
    loadStats().catch(() => undefined);
  }, [loadStats]);

  const refresh = () => {
    setRefreshing(true);
    load(0).catch(() => undefined);
    loadStats().catch(() => undefined);
  };

  const clear = () => {
    setStatusId('live');
    setSort('updated');
    setSdc('');
    setDraft('');
    setQ('');
  };

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.content}
      data={rows}
      keyExtractor={(item) => item.id}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.power} />}
      ListHeaderComponent={(
        <View style={styles.header}>
          <Eyebrow>Live board</Eyebrow>
          <Text style={styles.title}>{serviceLabel(service)}</Text>
          <ServiceSwitch />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {STATUSES.map((item) => (
              <Chip
                key={item.id}
                label={counts ? `${item.label} ${item.count(counts)}` : item.label}
                selected={statusId === item.id}
                accent={accent}
                onPress={() => setStatusId(item.id)}
              />
            ))}
          </ScrollView>
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
              <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setDraft('')} hitSlop={8}>
                <Ionicons name="close-circle" size={18} color={colors.faint} />
              </Pressable>
            )}
          </View>
          <View style={styles.chips}>
            {SORTS.map((item) => (
              <Chip key={item.id} label={item.label} selected={sort === item.id} accent={accent} onPress={() => setSort(item.id)} />
            ))}
          </View>
          {service === 'ELECTRICITY' && centres.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              <Chip label="All centres" selected={sdc === ''} accent={accent} onPress={() => setSdc('')} />
              {centres.map((item) => (
                <Chip
                  key={item.sdc}
                  label={`${prettyCentre(item.sdc)} ${item.count}`}
                  selected={sdc === item.sdc}
                  accent={accent}
                  onPress={() => setSdc(item.sdc)}
                />
              ))}
            </ScrollView>
          )}
          <Text style={styles.lede}>
            {loading && rows.length === 0
              ? 'Loading incidents…'
              : total === 0
                ? `No ${serviceLabel(service).toLowerCase()} incidents match`
                : `Showing ${rows.length} of ${total}`}
            {centre ? ` in ${prettyCentre(centre)}` : ''}
            {q ? ` matching “${q}”` : ''}
          </Text>
          {error && <Banner>{error}</Banner>}
        </View>
      )}
      ListEmptyComponent={loading ? <ActivityIndicator color={colors.power} style={styles.spinner} /> : error ? null : (
        <View style={styles.empty}>
          <StatusIcon name="check" tone="idle" />
          <Text style={styles.emptyTitle}>{filtered ? 'Nothing matches these filters' : `No ${status.label.toLowerCase()} ${serviceLabel(service).toLowerCase()} incidents`}</Text>
          <Text style={styles.emptyCopy}>{filtered ? 'Try another status, centre, or search.' : 'When a notice names a suburb, it appears here.'}</Text>
          {filtered && <SecondaryButton label="Clear filters" icon="close" onPress={clear} />}
        </View>
      )}
      ListFooterComponent={rows.length > 0 && rows.length < total ? (
        <View style={styles.more}>
          {loadingMore ? <ActivityIndicator color={colors.power} /> : <SecondaryButton label="Show more" icon="chevron-down" onPress={() => load(rows.length)} />}
        </View>
      ) : null}
      renderItem={({ item }) => <OutageRow outage={item} />}
    />
  );
}

function Chip({ label, selected, accent, onPress }: { label: string; selected: boolean; accent: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && { backgroundColor: accent, borderColor: accent }]}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelOn]}>{label}</Text>
    </Pressable>
  );
}

function prettyCentre(name: string) {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2');
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.page },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 32 },
  header: { gap: 12, marginBottom: 14 },
  title: { color: colors.text, fontFamily: font.bold, fontSize: 32, letterSpacing: -0.8 },
  chips: { flexDirection: 'row', gap: 8, paddingRight: 8 },
  chip: { borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, paddingHorizontal: 14, paddingVertical: 8 },
  chipLabel: { color: colors.text, fontFamily: font.semibold, fontSize: 13, lineHeight: 18 },
  chipLabelOn: { color: '#1a1408' },
  field: { minHeight: 48, borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 8 },
  input: { flex: 1, color: colors.text, fontFamily: font.text, fontSize: 16, paddingVertical: 10 },
  lede: { color: colors.muted, fontFamily: font.text, fontSize: 14, lineHeight: 20 },
  spinner: { marginTop: 24 },
  empty: { alignItems: 'flex-start', gap: 8, paddingVertical: 18 },
  emptyTitle: { color: colors.text, fontFamily: font.semibold, fontSize: 17 },
  emptyCopy: { color: colors.muted, fontFamily: font.text, fontSize: 14, lineHeight: 20 },
  more: { paddingTop: 6, paddingBottom: 12 },
});
