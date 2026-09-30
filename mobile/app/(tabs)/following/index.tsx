import { Stack } from 'expo-router/js-stack';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PixelRatio, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { api } from '@/src/lib/api';
import { withTimeout } from '@/src/lib/deadline.js';
import { keepFollowingCache, loadingUnit, mergeUnit } from '@/src/lib/following-status.js';
import { readCache, writeCache } from '@/src/lib/storage';
import { ALERT_COPY } from '@/src/lib/alerts.js';
import { savedAgeLabel } from '@/src/lib/time.js';
import { useApp, type Suburb } from '@/src/state/app';
import { Banner, SecondaryButton, StatusIcon } from '@/src/components/ui';
import { colors, font, reading, toneColor } from '@/src/theme';

type Unit = { state: 'loading' | 'ok' | 'error' | 'stale'; label: string; tone: string; icon: string; savedAt: number | null };
type RowStatus = { id: string; name: string; power: Unit; water: Unit };

export default function FollowingScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const stacked = PixelRatio.getFontScale() > 1.15 || width < 340;
  const { following, follow, unfollow, alertStatus, alertMessage, quiet, notice, clearNotice, pendingSync, retryAlerts, openAlertSettings } = useApp();
  const [rows, setRows] = useState<RowStatus[]>([]);
  const [editing, setEditing] = useState(false);
  const [undo, setUndo] = useState<Suburb | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async (list: Suburb[], onlyId?: string) => {
    const token = ++generation.current;
    if (!list.length) {
      setRows([]);
      return;
    }
    let cached: { data?: RowStatus[] } | null = null;
    try {
      cached = await readCache<RowStatus[]>('following');
    } catch {
      cached = null;
    }
    if (token !== generation.current) return;
    const saved = new Map((cached?.data ?? []).filter((row) => list.some((item) => item.id === row.id)).map((row) => [row.id, row]));
    const needsRetry = (unit?: Unit) => !unit || unit.state === 'error' || unit.state === 'stale' || unit.state === 'loading';
    const seed: RowStatus[] = list.map((suburb): RowStatus => {
      const known = saved.get(suburb.id);
      if (onlyId && suburb.id === onlyId && known) {
        return { id: suburb.id, name: suburb.name, power: needsRetry(known.power) ? loadingUnit() as Unit : known.power, water: needsRetry(known.water) ? loadingUnit() as Unit : known.water };
      }
      if (known) return { ...known, name: suburb.name, power: { ...known.power, state: known.power.state === 'ok' ? 'stale' as const : known.power.state }, water: { ...known.water, state: known.water.state === 'ok' ? 'stale' as const : known.water.state } };
      return { id: suburb.id, name: suburb.name, power: loadingUnit() as Unit, water: loadingUnit() as Unit };
    });
    setRows(seed);
    const targets = onlyId ? list.filter((item) => item.id === onlyId) : list;
    const queue = [...targets];
    const produced = new Map<string, RowStatus>(seed.map((row) => [row.id, row]));
    const worker = async () => {
      while (queue.length) {
        const suburb = queue.shift();
        if (!suburb || token !== generation.current) return;
        const prior = produced.get(suburb.id);
        const publish = (service: 'ELECTRICITY' | 'WATER', settled: PromiseSettledResult<{ data: unknown[] }>) => {
          if (token !== generation.current) return;
          const current = produced.get(suburb.id) ?? prior;
          const row: RowStatus = {
            id: suburb.id,
            name: suburb.name,
            power: service === 'ELECTRICITY' ? mergeUnit(current?.power, settled, 'ELECTRICITY') as Unit : (current?.power ?? loadingUnit() as Unit),
            water: service === 'WATER' ? mergeUnit(current?.water, settled, 'WATER') as Unit : (current?.water ?? loadingUnit() as Unit),
          };
          produced.set(suburb.id, row);
          setRows(list.map((item): RowStatus => produced.get(item.id) ?? { id: item.id, name: item.name, power: loadingUnit() as Unit, water: loadingUnit() as Unit }));
        };
        const powerRequest = withTimeout(api.localityOutages(suburb.id, 'ELECTRICITY'));
        const waterRequest = withTimeout(api.localityOutages(suburb.id, 'WATER'));
        powerRequest.then((value) => publish('ELECTRICITY', { status: 'fulfilled', value }), (reason) => publish('ELECTRICITY', { status: 'rejected', reason }));
        waterRequest.then((value) => publish('WATER', { status: 'fulfilled', value }), (reason) => publish('WATER', { status: 'rejected', reason }));
        await Promise.allSettled([powerRequest, waterRequest]);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (token !== generation.current) return;
    const ordered = list.map((suburb) => produced.get(suburb.id)).filter((row): row is RowStatus => Boolean(row));
    const stored = keepFollowingCache(cached?.data ?? [], ordered);
    setRows(stored as RowStatus[]);
    writeCache('following', stored).catch(() => undefined);
  }, []);

  useEffect(() => {
    load(following).catch(() => undefined);
  }, [following, load]);

  const remove = async (suburb: Suburb) => {
    setUndo(suburb);
    await unfollow(suburb.id);
  };

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(following).finally(() => setRefreshing(false)); }} tintColor={colors.power} />}
    >
      <Stack.Screen options={{
        title: `Following${following.length ? ` ${following.length}` : ''}`,
        headerRight: () => (
          <View style={styles.headerActions}>
            <Pressable accessibilityRole="button" accessibilityLabel={editing ? 'Done editing' : 'Edit list'} onPress={() => setEditing((value) => !value)} style={styles.headerHit}>
              <Text style={styles.headerText}>{editing ? 'Done' : 'Edit'}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Add a suburb" onPress={() => router.push({ pathname: '/outages/search', params: { pick: 'follow' } })} style={styles.headerHit}>
              <Text style={styles.headerText}>Add</Text>
            </Pressable>
          </View>
        ),
      }} />
      {alertStatus === 'denied' && <Banner tone="warning" action={{ label: 'Settings', onPress: openAlertSettings }}>{ALERT_COPY.denied}</Banner>}
      {pendingSync && <Banner tone="warning" action={{ label: 'Retry', onPress: () => { retryAlerts().catch(() => undefined); } }}>Saved on this phone. Alerts could not sync.</Banner>}
      {notice && <Banner action={{ label: 'Dismiss', onPress: clearNotice }}>{notice}</Banner>}
      {undo && (
        <Banner action={{ label: 'Undo', onPress: () => { follow(undo).then((result) => { if (result.status === 'failed' || result.message.startsWith('You can follow')) return; setUndo(null); }).catch(() => undefined); } }}>
          {`${undo.name} was removed from Following.`}
        </Banner>
      )}
      {following.length === 0 && (
        <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Add a suburb to watch power and water there.</Text>
        <SecondaryButton label="Add a suburb" icon="add" onPress={() => router.push({ pathname: '/outages/search', params: { pick: 'follow' } })} />
        </View>
      )}
      {following.map((suburb) => {
        const row = rows.find((item) => item.id === suburb.id);
        return (
          <View key={suburb.id} style={styles.card}>
            <Pressable accessibilityRole="button" accessibilityLabel={suburb.name} onPress={() => router.push({ pathname: '/suburb/[id]', params: { id: suburb.id } })} style={styles.cardMain}>
              <Text style={styles.name}>{suburb.name}</Text>
              <View style={[styles.pair, stacked && styles.pairStacked]}>
                <Mini label="Power" unit={row?.power} stacked={stacked} />
                <Mini label="Water" unit={row?.water} stacked={stacked} />
              </View>
            </Pressable>
            {editing && <SecondaryButton label="Remove" onPress={() => remove(suburb)} />}
            {(row?.power.state === 'error' || row?.water.state === 'error' || row?.power.state === 'stale' || row?.water.state === 'stale') && <SecondaryButton label="Retry" onPress={() => load(following, suburb.id)} />}
          </View>
        );
      })}
      <View style={styles.alert}>
        <Text style={styles.alertTitle}>{alertStatus === 'enabled' ? 'Alerts on' : 'Alerts'}</Text>
        <Text style={styles.copy}>{alertMessage || ALERT_COPY.off}</Text>
      </View>
      <Pressable accessibilityRole="button" onPress={() => router.push('/following/quiet')} style={styles.quiet}>
        <Text style={styles.quietTitle}>Quiet hours</Text>
        <Text style={styles.copy}>{quiet.from == null ? 'Off' : `${String(quiet.from).padStart(2, '0')}:00–${String(quiet.to).padStart(2, '0')}:00`}</Text>
      </Pressable>
    </ScrollView>
  );
}

function Mini({ label, unit, stacked }: { label: string; unit?: Unit; stacked?: boolean }) {
  return (
    <View style={styles.mini}>
      <Text style={styles.miniLabel}>{label}</Text>
      {unit ? <StatusIcon name={unit.icon} tone={unit.tone} size={28} /> : null}
      <Text style={[styles.miniValue, stacked && styles.miniStacked, { color: toneColor(unit?.tone ?? 'idle') }]}>{unit?.state === 'stale' ? `${unit.label} · ${savedAgeLabel(unit.savedAt)}` : unit?.label ?? 'Checking…'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { ...reading, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 36, gap: 12, backgroundColor: colors.page },
  headerActions: { flexDirection: 'row' },
  headerHit: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  headerText: { color: colors.power, fontFamily: font.semibold, fontSize: 16 },
  alert: { backgroundColor: colors.card, borderRadius: 16, padding: 14, gap: 4 },
  alertTitle: { color: colors.text, fontFamily: font.semibold, fontSize: 16 },
  copy: { color: colors.muted, fontFamily: font.text, fontSize: 14, lineHeight: 20 },
  quiet: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  quietTitle: { color: colors.text, fontFamily: font.semibold, fontSize: 16 },
  empty: { gap: 10, paddingVertical: 8 },
  emptyTitle: { color: colors.text, fontFamily: font.semibold, fontSize: 18 },
  card: { backgroundColor: colors.card, borderRadius: 16, padding: 12, gap: 8 },
  cardMain: { gap: 10 },
  name: { color: colors.text, fontFamily: font.bold, fontSize: 20 },
  pair: { flexDirection: 'row', gap: 10 },
  pairStacked: { flexDirection: 'column' },
  miniStacked: { flexShrink: 1 },
  mini: { flex: 1, gap: 4 },
  miniLabel: { color: colors.faint, fontFamily: font.semibold, fontSize: 12 },
  miniValue: { fontFamily: font.semibold, fontSize: 14, lineHeight: 18 },
});
