import { Stack } from 'expo-router/js-stack';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { sortOutages } from '@/src/lib/area.js';
import { api, type Outage } from '@/src/lib/api';
import { sameService } from '@/src/lib/query.js';
import { Banner, Eyebrow, OutageRow, PrimaryButton, SecondaryButton, SectionTitle, StatusIcon } from '@/src/components/ui';
import { useApp } from '@/src/state/app';
import { colors, font, serviceLabel } from '@/src/theme';

export default function SuburbScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const localityId = Array.isArray(id) ? id[0] : id;
  const { following, follow, unfollow } = useApp();
  const [name, setName] = useState('Suburb');
  const [municipality, setMunicipality] = useState<string | null>(null);
  const [power, setPower] = useState<Outage[]>([]);
  const [water, setWater] = useState<Outage[]>([]);
  const [possiblePower, setPossiblePower] = useState<Outage[]>([]);
  const [possibleWater, setPossibleWater] = useState<Outage[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const followed = following.some((item) => item.id === localityId);

  useEffect(() => {
    if (!localityId) return;
    let live = true;
    Promise.all([
      api.locality(localityId),
      api.localityOutages(localityId, 'ELECTRICITY'),
      api.localityOutages(localityId, 'WATER'),
    ]).then(([locality, electricity, supply]) => {
      if (!live) return;
      setName(locality.name);
      setMunicipality(locality.municipality);
      setPower(sortOutages(sameService(electricity.data, 'ELECTRICITY')));
      setWater(sortOutages(sameService(supply.data, 'WATER')));
      setPossiblePower(sortOutages(sameService(electricity.possible, 'ELECTRICITY')));
      setPossibleWater(sortOutages(sameService(supply.possible, 'WATER')));
    }).catch(() => {
      if (live) setNote('This suburb could not be loaded.');
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [localityId]);

  const onFollow = async () => {
    if (!localityId) return;
    if (followed) {
      await unfollow(localityId);
      setNote(null);
      return;
    }
    const result = await follow({ id: localityId, name });
    setNote(result.message);
  };

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Stack.Screen options={{ title: name }} />
      {loading && <ActivityIndicator color={colors.power} />}
      {municipality ? <Eyebrow>{municipality}</Eyebrow> : <Eyebrow>Suburb</Eyebrow>}
      <Text style={styles.name}>{name}</Text>
      <View style={styles.followCard}>
        <StatusIcon name={followed ? 'check' : 'notifications-outline'} tone={followed ? 'good' : 'plan'} size={36} />
        <View style={styles.followCopy}>
          <Text style={styles.followTitle}>{followed ? 'Alerts are on for this suburb' : 'Follow this suburb'}</Text>
          <Text style={styles.reason}>Follow asks to send alerts to this phone when a notice names it.</Text>
        </View>
      </View>
      {followed ? <SecondaryButton label="Unfollow" icon="heart-dislike" onPress={onFollow} /> : <PrimaryButton label="Follow" icon="notifications" onPress={onFollow} />}
      {note && <Banner>{note}</Banner>}
      <ServiceList title="Power" rows={power} />
      <ServiceList title="Water" rows={water} />
      {(possiblePower.length > 0 || possibleWater.length > 0) && (
        <>
          <SectionTitle title="Not named in the notice" detail="These incidents mention equipment that serves this suburb. The notice itself did not name it." />
          {possiblePower.map((outage) => <OutageRow key={outage.id} outage={outage} showService />)}
          {possibleWater.map((outage) => <OutageRow key={outage.id} outage={outage} showService />)}
        </>
      )}
    </ScrollView>
  );
}

function ServiceList({ title, rows }: { title: string; rows: Outage[] }) {
  const service = title === 'Water' ? 'WATER' : 'ELECTRICITY';
  return (
    <View style={styles.block}>
      <SectionTitle title={title} detail={rows.length === 0 ? `No current ${serviceLabel(service).toLowerCase()} incident names this suburb.` : `${rows.length} named`} />
      {rows.map((outage) => <OutageRow key={outage.id} outage={outage} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 36, gap: 14, backgroundColor: colors.page },
  name: { color: colors.text, fontFamily: font.bold, fontSize: 34, letterSpacing: -0.8 },
  reason: { color: colors.muted, fontFamily: font.text, fontSize: 14, lineHeight: 20 },
  followCard: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', backgroundColor: colors.card, borderRadius: 18, padding: 14, borderWidth: 1, borderColor: colors.line },
  followCopy: { flex: 1, gap: 4 },
  followTitle: { color: colors.text, fontFamily: font.semibold, fontSize: 16 },
  block: { gap: 8 },
});
