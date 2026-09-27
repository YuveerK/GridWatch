import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { hourLabel } from '@/src/lib/time.js';
import { useApp } from '@/src/state/app';
import { Eyebrow, PrimaryButton, SecondaryButton } from '@/src/components/ui';
import { colors, font } from '@/src/theme';

function bump(hour: number | null, delta: number) {
  const base = hour ?? 22;
  return (base + delta + 24) % 24;
}

export default function QuietHoursScreen() {
  const { quiet, setQuiet } = useApp();
  const [from, setFrom] = useState<number | null>(quiet.from);
  const [to, setTo] = useState<number | null>(quiet.to);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    await setQuiet(from, to);
    setSaved(true);
  };

  return (
    <View style={styles.page}>
      <Eyebrow>Alerts</Eyebrow>
      <Text style={styles.title}>Quiet hours</Text>
      <Text style={styles.copy}>Alerts for followed suburbs wait until this window ends. Both hours are saved together.</Text>
      <HourRow label="From" hour={from} onChange={(hour) => { setFrom(hour); setTo((current) => current ?? 6); setSaved(false); }} />
      <HourRow label="Until" hour={to} onChange={(hour) => { setTo(hour); setFrom((current) => current ?? 22); setSaved(false); }} />
      <SecondaryButton label="No quiet hours" icon="close" onPress={() => { setFrom(null); setTo(null); setSaved(false); }} />
      <PrimaryButton label="Save" icon="checkmark" onPress={save} />
      {saved && <Text style={styles.saved}>{from == null ? 'Alerts can arrive at any hour.' : `Quiet from ${hourLabel(from)} until ${hourLabel(to ?? from)}.`}</Text>}
    </View>
  );
}

function HourRow({ label, hour, onChange }: { label: string; hour: number | null; onChange: (hour: number | null) => void }) {
  return (
    <View style={styles.card}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${label} earlier`} onPress={() => onChange(bump(hour, -1))} style={styles.step}>
          <Ionicons name="remove" size={22} color={colors.text} />
        </Pressable>
        <Text style={styles.hour}>{hour == null ? 'Any' : hourLabel(hour)}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`${label} later`} onPress={() => onChange(bump(hour, 1))} style={styles.step}>
          <Ionicons name="add" size={22} color={colors.text} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.page, paddingHorizontal: 20, paddingTop: 12, gap: 14 },
  title: { color: colors.text, fontFamily: font.bold, fontSize: 32, letterSpacing: -0.8 },
  copy: { color: colors.muted, fontFamily: font.text, fontSize: 15, lineHeight: 22 },
  card: { backgroundColor: colors.card, borderRadius: 20, padding: 16, gap: 12, borderWidth: 1, borderColor: colors.line },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { color: colors.faint, fontFamily: font.semibold, fontSize: 11, letterSpacing: 1.1, textTransform: 'uppercase' },
  step: { width: 52, height: 52, borderRadius: 16, backgroundColor: colors.cardRaised, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line },
  hour: { color: colors.text, fontFamily: font.mono, fontSize: 36, letterSpacing: -1, minWidth: 120, textAlign: 'center' },
  saved: { color: colors.good, fontFamily: font.semibold, fontSize: 15 },
});
