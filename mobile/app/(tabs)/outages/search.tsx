import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, type SearchSuburb } from '@/src/lib/api';
import { sameService } from '@/src/lib/query.js';
import { statusMeta } from '@/src/lib/status.js';
import { useApp } from '@/src/state/app';
import { colors, font, serviceLabel, toneColor } from '@/src/theme';

type Hit =
  | { kind: 'suburb'; id: string; title: string; meta: string; suburb: SearchSuburb }
  | { kind: 'outage'; id: string; title: string; meta: string; status: string; service: 'ELECTRICITY' | 'WATER'; waterState: string | null };

export default function SearchScreen() {
  const router = useRouter();
  const { pick } = useLocalSearchParams<{ pick?: string }>();
  const { service, setSuburb, follow } = useApp();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      api.search(query, service).then((result) => {
        if (!live) return;
        const suburbs: Hit[] = result.suburbs.map((suburb) => ({
          kind: 'suburb',
          id: suburb.id,
          title: suburb.name,
          meta: suburb.municipality ?? 'Suburb',
          suburb,
        }));
        const outages: Hit[] = sameService(result.outages, service).map((outage) => {
          const meta = statusMeta(outage.status, outage.service, outage.waterState);
          return { kind: 'outage', id: outage.id, title: outage.title, meta: meta.label, status: outage.status, service: outage.service, waterState: outage.waterState };
        });
        setHits([...suburbs, ...outages]);
      }).catch(() => {
        if (live) setNote('Search could not reach GridWatch.');
      });
    }, 280);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, service]);

  const open = async (hit: Hit) => {
    if (hit.kind === 'suburb' && pick === 'area') {
      setSuburb({ id: hit.suburb.id, name: hit.suburb.name });
      router.back();
      router.navigate('/');
      return;
    }
    if (hit.kind === 'suburb' && pick === 'follow') {
      const result = await follow({ id: hit.suburb.id, name: hit.suburb.name });
      if (result.message && !result.alerts) {
        setNote(result.message);
        if (result.message.startsWith('You can follow')) return;
      }
      router.back();
      router.navigate('/following');
      return;
    }
    if (hit.kind === 'suburb') {
      router.push({ pathname: '/suburb/[id]', params: { id: hit.id } });
      return;
    }
    router.push({ pathname: '/outage/[id]', params: { id: hit.id } });
  };

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.content}
      data={hits}
      keyExtractor={(item) => `${item.kind}:${item.id}`}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={(
        <View style={styles.header}>
          <View style={styles.field}>
            <Ionicons name="search" size={18} color={colors.faint} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder={`Search ${serviceLabel(service).toLowerCase()}`}
              placeholderTextColor={colors.faint}
              autoCapitalize="words"
              autoCorrect={false}
              style={styles.input}
              accessibilityLabel="Search"
            />
          </View>
          <Text style={styles.hint}>
            {pick === 'area' ? 'Tap a suburb to save it as your area.' : pick === 'follow' ? 'Tap a suburb to follow it.' : 'Suburbs open their page. Incidents open on top of this tab.'}
          </Text>
          {q.trim().length >= 2 && hits.length === 0 && <Text style={styles.hint}>No matches in {serviceLabel(service).toLowerCase()}.</Text>}
          {note && <Text style={styles.note}>{note}</Text>}
        </View>
      )}
      renderItem={({ item }) => {
        const tone = item.kind === 'outage' ? statusMeta(item.status, item.service, item.waterState).tone : 'idle';
        return (
          <Pressable accessibilityRole="button" onPress={() => open(item)} style={({ pressed }) => [styles.row, pressed && { opacity: 0.82 }]}>
            <View style={styles.mark}>
              <Ionicons name={item.kind === 'suburb' ? 'location' : item.service === 'WATER' ? 'water' : 'flash'} size={16} color={item.kind === 'outage' ? toneColor(tone) : colors.power} />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.title}>{item.title}</Text>
              <Text style={[styles.meta, item.kind === 'outage' && { color: toneColor(tone) }]}>{item.meta}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.faint} />
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.page },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 32 },
  header: { gap: 10, marginBottom: 12 },
  field: { minHeight: 52, borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 8 },
  input: { flex: 1, color: colors.text, fontFamily: font.text, fontSize: 16, paddingVertical: 12 },
  hint: { color: colors.muted, fontFamily: font.text, fontSize: 14, lineHeight: 20 },
  note: { color: colors.partial, fontFamily: font.text, fontSize: 14 },
  row: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: 16, paddingHorizontal: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.line },
  mark: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.cardRaised, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, gap: 2 },
  title: { color: colors.text, fontFamily: font.semibold, fontSize: 16 },
  meta: { color: colors.muted, fontFamily: font.text, fontSize: 13 },
});
