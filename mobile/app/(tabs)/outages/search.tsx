import { Stack } from 'expo-router/js-stack';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, type SearchSuburb } from '@/src/lib/api';
import { sameService } from '@/src/lib/query.js';
import { statusMeta } from '@/src/lib/status.js';
import { useApp } from '@/src/state/app';
import { colors, font, reading, serviceLabel, toneColor } from '@/src/theme';

type Hit =
  | { kind: 'suburb'; id: string; title: string; meta: string; suburb: SearchSuburb }
  | { kind: 'outage'; id: string; title: string; meta: string; status: string; service: 'ELECTRICITY' | 'WATER'; waterState: string | null };

type Phase = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export default function SearchScreen() {
  const router = useRouter();
  const { pick } = useLocalSearchParams<{ pick?: string }>();
  const suburbOnly = pick === 'area' || pick === 'follow';
  const title = pick === 'area' ? 'Choose my suburb' : pick === 'follow' ? 'Add a suburb' : 'Search GridWatch';
  const { service, setSuburb, follow } = useApp();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState<string | null>(null);
  const [shownQuery, setShownQuery] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const query = q.trim();
    setNote(null);
    if (query.length < 2) {
      generation.current += 1;
      setHits([]);
      setPhase('idle');
      return;
    }
    const token = ++generation.current;
    setPhase('loading');
    const timer = setTimeout(() => {
      api.search(query, service).then((result) => {
        if (token !== generation.current) return;
        const suburbs: Hit[] = result.suburbs.map((suburb) => ({
          kind: 'suburb',
          id: suburb.id,
          title: suburb.name,
          meta: suburb.municipality ?? 'Suburb',
          suburb,
        }));
        const outages: Hit[] = suburbOnly ? [] : sameService(result.outages, service).map((outage) => {
          const meta = statusMeta(outage.status, outage.service, outage.waterState);
          return { kind: 'outage' as const, id: outage.id, title: outage.title, meta: meta.label, status: outage.status, service: outage.service, waterState: outage.waterState };
        });
        const next = [...suburbs, ...outages];
        setHits(next);
        setShownQuery(query);
        setPhase(next.length ? 'ready' : 'empty');
      }).catch(() => {
        if (token !== generation.current) return;
        setHits([]);
        setShownQuery('');
        setPhase('error');
      });
    }, 280);
    return () => clearTimeout(timer);
  }, [q, service, suburbOnly, attempt]);

  const open = async (hit: Hit) => {
    if (busyId) return;
    if (hit.kind === 'suburb' && pick === 'area') {
      setSuburb({ id: hit.suburb.id, name: hit.suburb.name });
      router.back();
      router.navigate('/');
      return;
    }
    if (hit.kind === 'suburb' && pick === 'follow') {
      setBusyId(hit.id);
      setNote(null);
      try {
        const result = await follow({ id: hit.suburb.id, name: hit.suburb.name });
        setNote(result.message);
        if (result.message.startsWith('You can follow') || result.status === 'failed') return;
        router.back();
        router.navigate('/following');
      } finally {
        setBusyId(null);
      }
      return;
    }
    if (hit.kind === 'suburb') {
      router.push({ pathname: '/suburb/[id]', params: { id: hit.id } });
      return;
    }
    router.push({ pathname: '/outage/[id]', params: { id: hit.id } });
  };

  const current = phase === 'ready' && shownQuery === q.trim();
  const suburbs = current ? hits.filter((hit) => hit.kind === 'suburb') : [];
  const incidents = current ? hits.filter((hit) => hit.kind === 'outage') : [];

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.content}
      data={suburbOnly && current ? hits : []}
      keyExtractor={(item) => `${item.kind}:${item.id}`}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={(
        <View style={styles.header}>
          <Stack.Screen options={{ title }} />
          <View style={styles.field}>
            <Ionicons name="search" size={18} color={colors.faint} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder={suburbOnly ? 'Suburb name' : `Search ${serviceLabel(service).toLowerCase()}`}
              placeholderTextColor={colors.faint}
              autoCapitalize="words"
              autoCorrect={false}
              style={styles.input}
              accessibilityLabel="Search"
            />
            {q.length > 0 && (
              <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQ('')} style={styles.clear}>
                <Ionicons name="close" size={18} color={colors.text} />
              </Pressable>
            )}
          </View>
          {phase === 'idle' && <Text style={styles.hint}>Enter at least 2 characters.</Text>}
          {phase === 'loading' && <ActivityIndicator color={colors.power} />}
          {phase === 'empty' && <Text style={styles.hint}>{suburbOnly ? `No suburbs found for “${q.trim()}”.` : `No results for “${q.trim()}”.`}</Text>}
          {phase === 'error' && (
            <Pressable accessibilityRole="button" onPress={() => setAttempt((value) => value + 1)} style={styles.retry}>
              <Text style={styles.note}>Search is unavailable. Retry.</Text>
            </Pressable>
          )}
          {note && <Text style={styles.note}>{note}</Text>}
          {!suburbOnly && phase === 'ready' && (
            <View style={styles.groups}>
              <Text style={styles.group}>Suburbs</Text>
              {suburbs.length === 0 && <Text style={styles.hint}>No suburbs found for “{q.trim()}”.</Text>}
              {suburbs.map((item) => <Result key={item.id} item={item} onPress={() => open(item)} />)}
              <Text style={styles.group}>Incidents</Text>
              {incidents.length === 0 && <Text style={styles.hint}>No incidents found for “{q.trim()}”.</Text>}
              {incidents.map((item) => <Result key={item.id} item={item} onPress={() => open(item)} />)}
            </View>
          )}
        </View>
      )}
      renderItem={({ item }) => <Result item={item} onPress={() => open(item)} />}
    />
  );
}

function Result({ item, onPress }: { item: Hit; onPress: () => void }) {
  const tone = item.kind === 'outage' ? statusMeta(item.status, item.service, item.waterState).tone : 'idle';
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={item.title} onPress={onPress} style={({ pressed }) => [styles.row, pressed && { opacity: 0.82 }]}>
      <View style={styles.mark}>
        <Ionicons name={item.kind === 'suburb' ? 'location' : item.service === 'WATER' ? 'water' : 'flash'} size={16} color={item.kind === 'outage' ? toneColor(tone) : colors.power} />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.title}>{item.title}</Text>
        <Text style={[styles.meta, item.kind === 'outage' && { color: toneColor(tone) }]}>{item.meta}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.page },
  content: { ...reading, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 32 },
  header: { gap: 12, marginBottom: 8 },
  field: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.card, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 },
  input: { flex: 1, color: colors.text, fontFamily: font.text, fontSize: 16, paddingVertical: 10 },
  clear: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  hint: { color: colors.muted, fontFamily: font.text, fontSize: 15, lineHeight: 21 },
  note: { color: colors.partial, fontFamily: font.text, fontSize: 15, lineHeight: 21 },
  retry: { minHeight: 48, justifyContent: 'center' },
  groups: { gap: 8 },
  group: { color: colors.text, fontFamily: font.bold, fontSize: 18, marginTop: 8 },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  mark: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, gap: 2 },
  title: { color: colors.text, fontFamily: font.semibold, fontSize: 16 },
  meta: { color: colors.muted, fontFamily: font.text, fontSize: 13 },
});
