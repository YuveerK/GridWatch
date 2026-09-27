import { Stack } from 'expo-router/js-stack';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { equipmentLabel } from '@/src/lib/area.js';
import { api, ApiError, type Outage } from '@/src/lib/api';
import { progressStep, roleLabel, statusMeta } from '@/src/lib/status.js';
import { relativeTime } from '@/src/lib/time.js';
import { Pill, StatusIcon } from '@/src/components/ui';
import { colors, font, serviceLabel, toneColor, toneTint } from '@/src/theme';
import { useRouter } from 'expo-router';

export default function IncidentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const outageId = Array.isArray(id) ? id[0] : id;
  const router = useRouter();
  const [outage, setOutage] = useState<Outage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!outageId) return;
    let live = true;
    api.outage(outageId).then((row) => {
      if (live) setOutage(row);
    }).catch((err) => {
      if (!live) return;
      setError(err instanceof ApiError && err.status === 404 ? 'This incident is no longer listed.' : 'The incident could not be loaded.');
    });
    return () => {
      live = false;
    };
  }, [outageId]);

  const service = outage?.service ?? 'ELECTRICITY';
  const meta = outage ? statusMeta(outage.status, service, outage.waterState) : null;
  const step = outage ? progressStep(outage.status, service, outage.waterState) : 0;
  const posts = outage?.timeline ?? [];

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Stack.Screen options={{ title: outage ? serviceLabel(service) : 'Incident' }} />
      {!outage && !error && <ActivityIndicator color={colors.power} />}
      {error && <Text style={styles.body}>{error}</Text>}
      {outage && meta && (
        <>
          <View style={[styles.hero, { backgroundColor: toneTint(meta.tone) }]}>
            <View style={styles.heroTop}>
              <StatusIcon name={meta.icon} tone={meta.tone} size={44} />
              <Pill label={serviceLabel(service)} tone={service === 'WATER' ? 'plan' : 'partial'} />
            </View>
            <Text style={styles.place}>{outage.localities?.[0]?.canonicalName || outage.title}</Text>
            <Text style={[styles.label, { color: toneColor(meta.tone) }]}>{meta.label}</Text>
            <Text style={styles.sentence}>{meta.long}</Text>
            {outage.title && outage.title !== outage.localities?.[0]?.canonicalName ? <Text style={styles.notice}>{outage.title}</Text> : null}
          </View>
          <View style={styles.rail}>
            {['Reported', 'Under way', 'Restored'].map((label, index) => {
              const reached = index <= step;
              return (
                <View key={label} style={styles.railStep}>
                  <View style={[styles.railDot, reached && { backgroundColor: toneColor(meta.tone), borderColor: toneColor(meta.tone) }]} />
                  <Text style={[styles.railLabel, reached && { color: colors.text }]}>{label}</Text>
                </View>
              );
            })}
          </View>
          <View style={styles.facts}>
            <Fact label="Started" value={relativeTime(outage.startedAt)} />
            <Fact label="Updated" value={relativeTime(outage.lastUpdateAt)} />
            <Fact label="Progress" value={outage.restorationPercent == null ? '—' : `${outage.restorationPercent}%`} />
            <Fact label="Posts" value={String(posts.length)} />
          </View>
          {outage.eta ? <Text style={styles.eta}>Expected {outage.eta}</Text> : null}
          {outage.municipality?.name ? <Text style={styles.meta}>{outage.municipality.name}</Text> : null}
          <Text style={styles.section}>Suburbs named</Text>
          <View style={styles.chips}>
            {(outage.localities ?? []).length === 0 && <Text style={styles.body}>No suburb was named in the notice.</Text>}
            {(outage.localities ?? []).map((locality) => (
              <Pressable key={locality.id} style={styles.chip} onPress={() => router.push({ pathname: '/suburb/[id]', params: { id: locality.id } })}>
                <Ionicons name="location" size={14} color={colors.power} />
                <Text style={styles.chipText}>{locality.canonicalName}</Text>
              </Pressable>
            ))}
          </View>
          {outage.cause && (
            <View style={styles.block}>
              <Text style={styles.section}>Cause</Text>
              <Text style={styles.body}>{outage.cause}</Text>
            </View>
          )}
          {(outage.infrastructure ?? []).length > 0 && (
            <View style={styles.block}>
              <Text style={styles.section}>Equipment</Text>
              {(outage.infrastructure ?? []).map((node) => (
                <View key={node.id} style={styles.equip}>
                  <Ionicons name={service === 'WATER' ? 'water' : 'flash'} size={16} color={service === 'WATER' ? colors.water : colors.power} />
                  <Text style={styles.body}>{equipmentLabel(node)}</Text>
                </View>
              ))}
            </View>
          )}
          <Text style={styles.section}>What was posted</Text>
          {posts.length === 0 && <Text style={styles.body}>No posts are attached yet.</Text>}
          {posts.map((item, index) => {
            const tone = item.role === 'RESTORATION' ? 'good' : item.role === 'OPENED' ? 'live' : 'plan';
            return (
              <View key={`${item.postedAt}:${index}`} style={styles.event}>
                <View style={styles.eventRail}>
                  <View style={[styles.eventDot, { backgroundColor: toneColor(tone) }]} />
                  {index < posts.length - 1 && <View style={styles.eventLine} />}
                </View>
                <View style={styles.eventBody}>
                  <View style={styles.eventHead}>
                    <Text style={[styles.postRole, { color: toneColor(tone) }]}>{roleLabel(item.role, service)}</Text>
                    <Text style={styles.meta}>{relativeTime(item.postedAt)}</Text>
                  </View>
                  <Text style={styles.body}>{item.summary || item.text}</Text>
                  {item.url && (
                    <Pressable style={styles.linkRow} onPress={() => Linking.openURL(item.url!)}>
                      <Ionicons name="open-outline" size={15} color={colors.power} />
                      <Text style={styles.link}>Open the post</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            );
          })}
        </>
      )}
    </ScrollView>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 40, gap: 14, backgroundColor: colors.page },
  hero: { borderRadius: 22, padding: 18, gap: 8, borderWidth: 1, borderColor: colors.line },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  place: { color: colors.faint, fontFamily: font.semibold, fontSize: 12, letterSpacing: 1.1, textTransform: 'uppercase' },
  label: { fontFamily: font.bold, fontSize: 32, letterSpacing: -0.8 },
  sentence: { color: colors.text, fontFamily: font.text, fontSize: 17, lineHeight: 24 },
  notice: { color: colors.muted, fontFamily: font.text, fontSize: 14, lineHeight: 20 },
  rail: { flexDirection: 'row', gap: 8 },
  railStep: { flex: 1, gap: 8 },
  railDot: { height: 4, borderRadius: 2, backgroundColor: colors.cardRaised, borderWidth: 0 },
  railLabel: { color: colors.faint, fontFamily: font.semibold, fontSize: 11, letterSpacing: 0.3 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  fact: { width: '48%', flexGrow: 1, backgroundColor: colors.card, borderRadius: 16, padding: 12, gap: 4, borderWidth: 1, borderColor: colors.line },
  factLabel: { color: colors.faint, fontFamily: font.semibold, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' },
  factValue: { color: colors.text, fontFamily: font.mono, fontSize: 16 },
  eta: { color: colors.text, fontFamily: font.text, fontSize: 15 },
  meta: { color: colors.faint, fontFamily: font.mono, fontSize: 12 },
  section: { color: colors.text, fontFamily: font.bold, fontSize: 18, letterSpacing: -0.3, marginTop: 6 },
  body: { color: colors.text, fontFamily: font.text, fontSize: 16, lineHeight: 23 },
  block: { gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 40, borderRadius: 20, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card, flexDirection: 'row', gap: 6 },
  chipText: { color: colors.text, fontFamily: font.semibold, fontSize: 14 },
  equip: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  event: { flexDirection: 'row', gap: 12 },
  eventRail: { width: 14, alignItems: 'center' },
  eventDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  eventLine: { width: 1, flex: 1, backgroundColor: colors.line, marginTop: 4 },
  eventBody: { flex: 1, gap: 6, paddingBottom: 18 },
  eventHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' },
  postRole: { fontFamily: font.semibold, fontSize: 14 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  link: { color: colors.power, fontFamily: font.semibold, fontSize: 14 },
});
