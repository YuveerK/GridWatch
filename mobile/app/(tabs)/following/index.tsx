import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { areaHeadline } from '@/src/lib/area.js';
import { api, type Outage } from '@/src/lib/api';
import { readCache, writeCache } from '@/src/lib/storage';
import { ALERTS_OFF, useApp, type Suburb } from '@/src/state/app';
import { Banner, Eyebrow, SecondaryButton, StatusIcon } from '@/src/components/ui';
import { colors, font, toneColor } from '@/src/theme';

type RowStatus = { id: string; name: string; power: ReturnType<typeof areaHeadline>; water: ReturnType<typeof areaHeadline> };

export default function FollowingScreen() {
  const router = useRouter();
  const { following, unfollow, alerts, quiet } = useApp();
  const [rows, setRows] = useState<RowStatus[]>([]);
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (list: Suburb[]) => {
    if (!list.length) {
      setRows([]);
      return;
    }
    setRefreshing(true);
    try {
      const next = await Promise.all(list.map(async (suburb) => {
        const [power, water] = await Promise.all([
          api.localityOutages(suburb.id, 'ELECTRICITY'),
          api.localityOutages(suburb.id, 'WATER'),
        ]);
        return {
          id: suburb.id,
          name: suburb.name,
          power: areaHeadline(power.data as Outage[], 'ELECTRICITY'),
          water: areaHeadline(water.data as Outage[], 'WATER'),
        };
      }));
      setRows(next);
      setStale(false);
      await writeCache('following', next);
    } catch {
      const cached = await readCache<RowStatus[]>('following');
      if (cached) {
        const ids = new Set(list.map((item) => item.id));
        setRows(cached.data.filter((row) => ids.has(row.id)));
        setStale(true);
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(following).catch(() => undefined);
  }, [following, load]);

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(following)} tintColor={colors.power} />}
    >
      <Eyebrow>This phone</Eyebrow>
      <Text style={styles.title}>Following</Text>
      <Text style={styles.copy}>{following.length === 0 ? 'No suburbs yet.' : `${following.length} of 20 suburbs.`} Alerts use this same list when push is available.</Text>
      {!alerts && <Banner>{ALERTS_OFF}</Banner>}
      <View style={styles.actions}>
        <SecondaryButton
          label={quiet.from == null ? 'Quiet hours off' : `Quiet ${String(quiet.from).padStart(2, '0')}:00–${String(quiet.to).padStart(2, '0')}:00`}
          icon="moon"
          onPress={() => router.push('/following/quiet')}
        />
        <SecondaryButton label="Add a suburb" icon="add" onPress={() => router.push({ pathname: '/outages/search', params: { pick: 'follow' } })} />
      </View>
      {stale && <Banner>Showing the last status saved on this phone.</Banner>}
      {following.length === 0 && (
        <View style={styles.empty}>
          <StatusIcon name="heart-outline" tone="idle" />
          <Text style={styles.emptyTitle}>You are not following a suburb yet</Text>
          <Text style={styles.copy}>Add one to keep power and water status on this phone.</Text>
        </View>
      )}
      {following.map((suburb) => {
        const row = rows.find((item) => item.id === suburb.id);
        return (
          <View key={suburb.id} style={styles.card}>
            <Text style={styles.name} onPress={() => router.push({ pathname: '/suburb/[id]', params: { id: suburb.id } })}>{suburb.name}</Text>
            <View style={styles.pair}>
              <Mini label="Power" meta={row?.power} />
              <Mini label="Water" meta={row?.water} />
            </View>
            <SecondaryButton label="Unfollow" icon="heart-dislike" onPress={() => unfollow(suburb.id)} />
          </View>
        );
      })}
    </ScrollView>
  );
}

function Mini({ label, meta }: { label: string; meta?: { label: string; tone: string; icon: string } }) {
  return (
    <View style={styles.mini}>
      <Text style={styles.miniLabel}>{label}</Text>
      {meta ? <StatusIcon name={meta.icon} tone={meta.tone} size={28} /> : null}
      <Text style={[styles.miniValue, { color: toneColor(meta?.tone ?? 'idle') }]}>{meta?.label ?? 'Checking…'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 36, gap: 14, backgroundColor: colors.page },
  title: { color: colors.text, fontFamily: font.bold, fontSize: 32, letterSpacing: -0.8 },
  copy: { color: colors.muted, fontFamily: font.text, fontSize: 15, lineHeight: 22 },
  actions: { gap: 10 },
  empty: { gap: 8, paddingVertical: 8 },
  emptyTitle: { color: colors.text, fontFamily: font.semibold, fontSize: 17 },
  card: { backgroundColor: colors.card, borderRadius: 20, padding: 16, gap: 12, borderWidth: 1, borderColor: colors.line },
  name: { color: colors.text, fontFamily: font.bold, fontSize: 22, letterSpacing: -0.3 },
  pair: { flexDirection: 'row', gap: 10 },
  mini: { flex: 1, gap: 6, backgroundColor: colors.cardRaised, borderRadius: 14, padding: 10 },
  miniLabel: { color: colors.faint, fontFamily: font.semibold, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' },
  miniValue: { fontFamily: font.semibold, fontSize: 14 },
});
