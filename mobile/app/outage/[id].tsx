import { Stack } from 'expo-router/js-stack';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { placeName } from '@/src/lib/area.js';
import { api, ApiError, type Outage } from '@/src/lib/api';
import { roleLabel, statusMeta } from '@/src/lib/status.js';
import { clockTime } from '@/src/lib/time.js';
import { Pill, SecondaryButton, StatusIcon } from '@/src/components/ui';
import { useApp } from '@/src/state/app';
import { colors, font, reading, serviceColor, serviceLabel, toneColor } from '@/src/theme';

export default function IncidentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const outageId = Array.isArray(id) ? id[0] : id;
  const router = useRouter();
  const { now } = useApp();
  const [outage, setOutage] = useState<Outage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openPost, setOpenPost] = useState<number | null>(null);
  const request = useRef(0);

  const load = useCallback((refresh = false) => {
    if (!outageId) return;
    const token = ++request.current;
    const requested = outageId;
    if (!refresh) {
      setOutage(null);
      setOpenPost(null);
    }
    setLoading(true);
    setError(null);
    api.outage(requested).then((row) => {
      if (token !== request.current) return;
      setOutage(row);
      setError(null);
    }).catch((err) => {
      if (token !== request.current) return;
      if (!refresh) setOutage(null);
      setError(err instanceof ApiError && err.status === 404 ? 'This incident is no longer listed.' : 'The incident could not be loaded.');
    }).finally(() => {
      if (token === request.current) setLoading(false);
    });
  }, [outageId]);

  useEffect(() => {
    load(false);
    return () => {
      request.current += 1;
    };
  }, [load]);

  const service = outage?.service ?? 'ELECTRICITY';
  const meta = outage ? statusMeta(outage.status, service, outage.waterState) : null;
  const posts = [...(outage?.timeline ?? [])].reverse();
  const place = outage ? placeName(outage) : '';
  const localities = outage?.localities ?? [];
  const stillAffected = localities.filter((item) => !item.restored);
  const restoredHere = localities.filter((item) => item.restored);
  const likely = localities.length === 0 ? (outage?.likelyAreas ?? []) : [];
  const equipment = outage?.infrastructure ?? [];
  const centre = prettyLabel(outage?.sdcNode?.name || outage?.sdc || '');
  const latest = posts[0];
  const latestText = latest?.summary || latest?.text || '';

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Stack.Screen options={{ title: outage ? serviceLabel(service) : 'Incident' }} />
      {loading && !outage && <ActivityIndicator color={colors.power} />}
      {error && (
        <View style={styles.stack}>
          <Text style={styles.body}>{error}</Text>
          <SecondaryButton label="Retry" icon="refresh" onPress={() => load(true)} />
          <SecondaryButton label="Back to outages" onPress={() => router.navigate('/outages')} />
        </View>
      )}
      {outage && meta && (
        <>
          <Text style={styles.place}>{place}</Text>
          {localities.length > 1 && (
            <Text style={styles.scope}>{localities.length} suburbs named in this notice</Text>
          )}

          <View style={styles.statusRow}>
            <StatusIcon name={meta.icon} tone={meta.tone} />
            <View style={styles.statusCopy}>
              <Pill label={meta.label} tone={meta.tone} />
              <Text style={styles.sentence}>{meta.long}</Text>
              <Text style={styles.meta}>Updated {clockTime(outage.lastUpdateAt, now)}</Text>
            </View>
          </View>

          {outage.status === 'STALE' && <Text style={styles.note}>No recent update. That does not mean supply is back.</Text>}
          {outage.status === 'CLOSED' && <Text style={styles.note}>Closed. That is not the same as a confirmed restoration.</Text>}
          {outage.status === 'CANCELLED' && <Text style={styles.note}>This planned work was cancelled.</Text>}

          <Text style={styles.kicker}>Latest update</Text>
          <Text style={styles.lead}>{latestText || 'No update text is available yet.'}</Text>
          {latest?.url && (
            <Pressable accessibilityRole="link" style={styles.linkRow} onPress={() => Linking.openURL(latest.url!)}>
              <Ionicons name="open-outline" size={16} color={colors.power} />
              <Text style={styles.link}>Open the latest post</Text>
            </Pressable>
          )}

          <View style={styles.facts}>
            {(outage.scheduled?.date || outage.eta || (outage.status !== 'RESTORED' && outage.status !== 'CLOSED' && outage.status !== 'CANCELLED')) && (
              <Fact label={outage.scheduled?.date ? 'Planned window' : 'Estimate'}>
                <Text style={outage.scheduled?.date || outage.eta ? styles.factValue : styles.missing}>
                  {outage.scheduled?.date
                    ? `Scheduled ${outage.scheduled.date}${outage.scheduled.from && outage.scheduled.to ? `, ${outage.scheduled.from}–${outage.scheduled.to}` : ''}`
                    : outage.eta || 'No restoration time was reported.'}
                </Text>
              </Fact>
            )}
            <Fact label="Timing">
              <Text style={styles.factValue}>Started {clockTime(outage.startedAt, now)}</Text>
              {outage.restoredAt ? <Text style={styles.factValue}>Restored {clockTime(outage.restoredAt, now)}</Text> : null}
            </Fact>
            {typeof outage.restorationPercent === 'number' && (
              <Fact label="Reported restoration">
                <Text style={styles.factValue}>{outage.restorationPercent}%</Text>
                <View style={styles.track}>
                  <View style={[styles.fill, { width: `${Math.max(0, Math.min(100, outage.restorationPercent))}%`, backgroundColor: toneColor(meta.tone) }]} />
                </View>
              </Fact>
            )}
          </View>

          <Text style={styles.section}>Areas</Text>
          {stillAffected.length > 0 && <AreaGroup label={restoredHere.length ? 'Still named as affected' : 'Named in the notice'} items={stillAffected} onPress={(id) => router.push({ pathname: '/suburb/[id]', params: { id } })} />}
          {restoredHere.length > 0 && <AreaGroup label="Restored here" items={restoredHere} onPress={(id) => router.push({ pathname: '/suburb/[id]', params: { id } })} />}
          {likely.length > 0 && (
            <View style={styles.group}>
              <Text style={styles.groupLabel}>Possible areas</Text>
              <Text style={styles.missing}>The notice did not name a suburb. These are places this equipment often supplies.</Text>
              <View style={styles.chips}>
                {likely.map((item) => (
                  <Pressable key={item.id} accessibilityRole="button" style={styles.chip} onPress={() => router.push({ pathname: '/suburb/[id]', params: { id: item.id } })}>
                    <Text style={styles.chipText}>{item.canonicalName}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
          {localities.length === 0 && likely.length === 0 && <Text style={styles.missing}>No suburb was named.</Text>}

          <Text style={styles.section}>Updates</Text>
          {posts.length === 0 && <Text style={styles.missing}>No posts are attached yet.</Text>}
          {posts.map((item, index) => {
            const tone = item.role === 'RESTORATION' ? 'good' : item.role === 'OPENED' ? 'live' : 'plan';
            const shown = item.summary || item.text || 'No text for this update.';
            const original = item.summary && item.text && item.text.trim() !== item.summary.trim() ? item.text : null;
            const open = openPost === index;
            return (
              <View key={`${item.postedAt}:${index}`} style={styles.event}>
                <View style={styles.rail}>
                  <View style={[styles.dot, { backgroundColor: toneColor(tone) }]} />
                  {index < posts.length - 1 && <View style={styles.stem} />}
                </View>
                <View style={styles.eventBody}>
                  <Text style={[styles.postRole, { color: toneColor(tone) }]}>{roleLabel(item.role, service)}</Text>
                  <Text style={styles.body}>{shown}</Text>
                  <Text style={styles.meta}>{clockTime(item.postedAt, now)}</Text>
                  {original && (
                    <Pressable accessibilityRole="button" style={styles.linkRow} onPress={() => setOpenPost(open ? null : index)}>
                      <Text style={styles.link}>{open ? 'Hide original wording' : 'Read original wording'}</Text>
                    </Pressable>
                  )}
                  {open && original && <Text style={styles.original}>{original}</Text>}
                  {item.url && (
                    <Pressable accessibilityRole="link" style={styles.linkRow} onPress={() => Linking.openURL(item.url!)}>
                      <Ionicons name="open-outline" size={16} color={colors.power} />
                      <Text style={styles.link}>Open the post</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            );
          })}
          {(outage.cause || equipment.length > 0 || centre) && (
            <View style={styles.facts}>
              {outage.cause ? (
                <Fact label="Cause">
                  <Text style={styles.factValue}>{sentenceCase(outage.cause)}</Text>
                </Fact>
              ) : null}
              {equipment.length > 0 && (
                <Fact label="Equipment">
                  {equipment.map((node) => (
                    <View key={node.id} style={styles.equip}>
                      <Text style={[styles.equipType, { color: serviceColor(service) }]}>{prettyType(node.type)}</Text>
                      <Text style={styles.factValue}>{node.name}</Text>
                    </View>
                  ))}
                </Fact>
              )}
              {centre ? (
                <Fact label="Service centre">
                  <Text style={styles.factValue}>{centre}</Text>
                  <Text style={styles.missing}>The depot handling this area. It is not a piece of equipment.</Text>
                </Fact>
              ) : null}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      {children}
    </View>
  );
}

function AreaGroup({ label, items, onPress }: { label: string; items: { id: string; canonicalName: string }[]; onPress: (id: string) => void }) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{label}</Text>
      <View style={styles.chips}>
        {items.map((item) => (
          <Pressable key={item.id} accessibilityRole="button" style={styles.chip} onPress={() => onPress(item.id)}>
            <Text style={styles.chipText}>{item.canonicalName}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function sentenceCase(value: string) {
  const text = value.trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function prettyLabel(value: string) {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').trim();
}

function prettyType(value: string) {
  const text = prettyLabel(value.toLowerCase());
  return sentenceCase(text);
}

const styles = StyleSheet.create({
  page: { ...reading, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 48, backgroundColor: colors.page },
  stack: { gap: 12 },
  place: { color: colors.text, fontFamily: font.bold, fontSize: 36, lineHeight: 42 },
  scope: { color: colors.muted, fontFamily: font.text, fontSize: 16, lineHeight: 22, marginTop: 6 },
  statusRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', marginTop: 22 },
  statusCopy: { flex: 1, gap: 6 },
  sentence: { color: colors.text, fontFamily: font.text, fontSize: 17, lineHeight: 24 },
  note: { color: colors.muted, fontFamily: font.text, fontSize: 15, lineHeight: 22, marginTop: 12 },
  kicker: { color: colors.faint, fontFamily: font.semibold, fontSize: 13, lineHeight: 18, marginTop: 28 },
  lead: { color: colors.text, fontFamily: font.semibold, fontSize: 20, lineHeight: 28, marginTop: 6 },
  facts: { marginTop: 28, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  fact: { paddingVertical: 16, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  factLabel: { color: colors.faint, fontFamily: font.semibold, fontSize: 13, lineHeight: 18 },
  factValue: { color: colors.text, fontFamily: font.text, fontSize: 17, lineHeight: 24 },
  missing: { color: colors.muted, fontFamily: font.text, fontSize: 16, lineHeight: 22 },
  equip: { gap: 2, paddingTop: 4 },
  equipType: { fontFamily: font.semibold, fontSize: 13, lineHeight: 18 },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.cardRaised, overflow: 'hidden', marginTop: 6 },
  fill: { height: 6, borderRadius: 3 },
  section: { color: colors.text, fontFamily: font.bold, fontSize: 22, lineHeight: 28, marginTop: 32 },
  group: { gap: 8, marginTop: 14 },
  groupLabel: { color: colors.muted, fontFamily: font.semibold, fontSize: 14, lineHeight: 20 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 48, borderRadius: 14, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card },
  chipText: { color: colors.text, fontFamily: font.semibold, fontSize: 15, lineHeight: 20 },
  body: { color: colors.text, fontFamily: font.text, fontSize: 16, lineHeight: 23 },
  meta: { color: colors.faint, fontFamily: font.mono, fontSize: 12, lineHeight: 18 },
  event: { flexDirection: 'row', gap: 12, marginTop: 4 },
  rail: { width: 16, alignItems: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 8 },
  stem: { width: 1, flex: 1, backgroundColor: colors.line, marginTop: 4 },
  eventBody: { flex: 1, gap: 4, paddingBottom: 18 },
  postRole: { fontFamily: font.semibold, fontSize: 14, lineHeight: 20, marginTop: 2 },
  original: { color: colors.muted, fontFamily: font.text, fontSize: 15, lineHeight: 22 },
  linkRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 6 },
  link: { color: colors.power, fontFamily: font.semibold, fontSize: 15, lineHeight: 20 },
});
