import { Stack } from 'expo-router/js-stack';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { sortOutages } from '@/src/lib/area.js';
import { api, type Outage } from '@/src/lib/api';
import { withTimeout } from '@/src/lib/deadline.js';
import { sameService } from '@/src/lib/query.js';
import { Banner, OutageRow, SecondaryButton } from '@/src/components/ui';
import { useApp } from '@/src/state/app';
import { colors, font, reading } from '@/src/theme';

type Identity = { state: 'loading' | 'error' } | { state: 'ok'; name: string; municipality: string | null };
type Supply = { state: 'loading' | 'error' } | { state: 'ok'; rows: Outage[]; possible: Outage[] };

export default function SuburbScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const localityId = Array.isArray(id) ? id[0] : id;
  const router = useRouter();
  const { following, follow, unfollow, alertMessage, alertStatus } = useApp();
  const [identity, setIdentity] = useState<Identity>({ state: 'loading' });
  const [power, setPower] = useState<Supply>({ state: 'loading' });
  const [water, setWater] = useState<Supply>({ state: 'loading' });
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const followed = following.some((item) => item.id === localityId);

  const loadIdentity = useCallback((token: number) => {
    if (!localityId) return;
    setIdentity({ state: 'loading' });
    withTimeout(api.locality(localityId)).then((locality) => {
      if (token !== request.current) return;
      setIdentity({ state: 'ok', name: locality.name, municipality: locality.municipality });
    }).catch(() => {
      if (token !== request.current) return;
      setIdentity({ state: 'error' });
    });
  }, [localityId]);

  const loadService = useCallback((service: 'ELECTRICITY' | 'WATER', token: number) => {
    if (!localityId) return;
    const setSupply = service === 'WATER' ? setWater : setPower;
    setSupply({ state: 'loading' });
    withTimeout(api.localityOutages(localityId, service)).then((result) => {
      if (token !== request.current) return;
      setSupply({
        state: 'ok',
        rows: sortOutages(sameService(result.data, service)),
        possible: sortOutages(sameService(result.possible, service)),
      });
    }).catch(() => {
      if (token !== request.current) return;
      setSupply({ state: 'error' });
    });
  }, [localityId]);

  useEffect(() => {
    const token = ++request.current;
    setNote(null);
    setIdentity({ state: 'loading' });
    setPower({ state: 'loading' });
    setWater({ state: 'loading' });
    loadIdentity(token);
    loadService('ELECTRICITY', token);
    loadService('WATER', token);
    return () => {
      request.current += 1;
    };
  }, [loadIdentity, loadService, localityId]);

  const onFollow = async () => {
    if (!localityId || identity.state !== 'ok' || busy) return;
    setBusy(true);
    try {
      if (followed) {
        await unfollow(localityId);
        setNote('Removed from Following.');
        return;
      }
      const result = await follow({ id: localityId, name: identity.name });
      setNote(result.message);
    } finally {
      setBusy(false);
    }
  };

  const name = identity.state === 'ok' ? identity.name : '';
  const possible = [
    ...(power.state === 'ok' ? power.possible : []),
    ...(water.state === 'ok' ? water.possible : []),
  ];

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Stack.Screen options={{ title: 'Suburb' }} />
      {identity.state === 'loading' && <ActivityIndicator color={colors.power} />}
      {identity.state === 'error' && (
        <View style={styles.block}>
          <Text style={styles.body}>This suburb could not be loaded.</Text>
          <SecondaryButton label="Retry" onPress={() => loadIdentity(request.current)} />
        </View>
      )}
      {identity.state === 'ok' && (
        <>
          {identity.municipality ? <Text style={styles.meta}>{identity.municipality}</Text> : null}
          <Text style={styles.name} accessibilityRole="header">{name}</Text>
          <SecondaryButton label={followed ? 'Following' : 'Follow'} busy={busy} onPress={onFollow} />
          {followed && <Text style={styles.meta}>{alertStatus === 'enabled' ? 'Following is saved. Alerts cover power and water for this suburb.' : alertMessage}</Text>}
          {note && <Banner>{note}</Banner>}
          {note?.includes('20 suburbs') && <SecondaryButton label="Open Following" onPress={() => router.push('/following')} />}
        </>
      )}
      <ServiceList title="Power reported here" supply={power} empty="No current power incident names this suburb." onRetry={() => loadService('ELECTRICITY', request.current)} />
      <ServiceList title="Water reported here" supply={water} empty="No current water incident names this suburb." onRetry={() => loadService('WATER', request.current)} />
      {possible.length > 0 && (
        <View style={styles.possible}>
          <Text style={styles.section}>Possible nearby impact</Text>
          <Text style={styles.meta}>These incidents mention equipment that can serve this suburb. The notice itself did not name it. They are not confirmed local outages.</Text>
          {possible.map((outage) => <OutageRow key={outage.id} outage={outage} showService />)}
        </View>
      )}
    </ScrollView>
  );
}

function ServiceList({ title, supply, empty, onRetry }: { title: string; supply: Supply; empty: string; onRetry: () => void }) {
  return (
    <View style={styles.block}>
      <Text style={styles.section}>{title}</Text>
      {supply.state === 'loading' && <ActivityIndicator color={colors.power} />}
      {supply.state === 'error' && (
        <>
          <Text style={styles.meta}>Unavailable</Text>
          <SecondaryButton label="Retry" onPress={onRetry} />
        </>
      )}
      {supply.state === 'ok' && supply.rows.length === 0 && <Text style={styles.meta}>{empty}</Text>}
      {supply.state === 'ok' && supply.rows.map((outage) => <OutageRow key={outage.id} outage={outage} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { ...reading, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 36, gap: 12, backgroundColor: colors.page, flexGrow: 1 },
  name: { color: colors.text, fontFamily: font.bold, fontSize: 32, lineHeight: 38 },
  meta: { color: colors.muted, fontFamily: font.text, fontSize: 14, lineHeight: 20 },
  body: { color: colors.text, fontFamily: font.text, fontSize: 16, lineHeight: 22 },
  section: { color: colors.text, fontFamily: font.bold, fontSize: 20, lineHeight: 26 },
  block: { gap: 8 },
  possible: { gap: 8, marginTop: 8 },
});
