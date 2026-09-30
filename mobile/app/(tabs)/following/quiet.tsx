import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { QUIET_COPY } from '@/src/lib/alerts.js';
import { hourLabel, JOHANNESBURG_TIME } from '@/src/lib/time.js';
import { useApp } from '@/src/state/app';
import { PrimaryButton } from '@/src/components/ui';
import { colors, font, reading } from '@/src/theme';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export default function QuietHoursScreen() {
  const insets = useSafeAreaInsets();
  const { quiet, setQuiet } = useApp();
  const savedOn = quiet.from != null && quiet.to != null && quiet.from !== quiet.to;
  const [enabled, setEnabled] = useState(savedOn);
  const [from, setFrom] = useState(quiet.from ?? 22);
  const [to, setTo] = useState(quiet.to ?? 6);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [picking, setPicking] = useState<'from' | 'to' | null>(null);
  const dirty = enabled !== savedOn || (enabled && (from !== (quiet.from ?? 22) || to !== (quiet.to ?? 6)));

  const changeEnabled = (value: boolean) => {
    setEnabled(value);
    setMessage(null);
  };
  const changeHour = (hour: number) => {
    if (picking === 'from') setFrom(hour);
    if (picking === 'to') setTo(hour);
    setMessage(null);
    setPicking(null);
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await setQuiet(enabled ? from : null, enabled ? to : null);
      setMessage(result.message);
      if (enabled && from === to) setEnabled(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.copy}>{QUIET_COPY}</Text>
      <Text style={styles.meta}>{JOHANNESBURG_TIME}</Text>
      <View style={styles.switchRow}>
        <Text style={styles.label}>Pause alerts</Text>
        <Switch accessibilityLabel="Pause alerts during quiet hours" value={enabled} onValueChange={changeEnabled} trackColor={{ true: colors.power, false: colors.lineStrong }} />
      </View>
      {enabled && (
        <>
          <HourChoice label="From" hour={from} onPress={() => setPicking('from')} />
          <HourChoice label="Until" hour={to} onPress={() => setPicking('to')} />
          <Text style={styles.summary}>{from === to ? 'Those hours are equal, so quiet hours stay off.' : `${hourLabel(from)}–${hourLabel(to)}, ${JOHANNESBURG_TIME}.`}</Text>
        </>
      )}
      {dirty && <Text style={styles.meta}>Unsaved changes</Text>}
      <PrimaryButton label="Save changes" busy={busy} onPress={save} />
      {message && !dirty && <Text style={styles.copy}>{message}</Text>}
      <Modal visible={picking != null} animationType="none" transparent onRequestClose={() => setPicking(null)}>
        <View style={styles.modal}>
          <Pressable style={styles.backdrop} onPress={() => setPicking(null)} />
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>{picking === 'to' ? 'Until' : 'From'}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Close hours" onPress={() => setPicking(null)} style={styles.close}>
                <Text style={styles.closeLabel}>Close</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.hours}>
              {HOURS.map((hour) => {
                const selected = hour === (picking === 'to' ? to : from);
                return (
                  <Pressable key={hour} accessibilityRole="button" accessibilityState={{ selected }} onPress={() => changeHour(hour)} style={[styles.hour, selected && styles.hourOn]}>
                    <Text style={[styles.hourLabel, selected && styles.hourLabelOn]}>{hourLabel(hour)}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function HourChoice({ label, hour, onPress }: { label: string; hour: number; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label} ${hourLabel(hour)}`} onPress={onPress} style={styles.card}>
      <Text style={styles.kicker}>{label}</Text>
      <Text style={styles.hourValue}>{hourLabel(hour)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { ...reading, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40, gap: 14, backgroundColor: colors.page },
  copy: { color: colors.muted, fontFamily: font.text, fontSize: 15, lineHeight: 22 },
  meta: { color: colors.faint, fontFamily: font.mono, fontSize: 12 },
  switchRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { color: colors.text, fontFamily: font.semibold, fontSize: 16 },
  card: { minHeight: 48, backgroundColor: colors.card, borderRadius: 16, padding: 14, gap: 4 },
  kicker: { color: colors.faint, fontFamily: font.semibold, fontSize: 12 },
  hourValue: { color: colors.text, fontFamily: font.mono, fontSize: 28 },
  summary: { color: colors.text, fontFamily: font.text, fontSize: 16, lineHeight: 22 },
  modal: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { maxHeight: '70%', backgroundColor: colors.cardRaised, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, gap: 12 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { color: colors.text, fontFamily: font.bold, fontSize: 22 },
  close: { minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center' },
  closeLabel: { color: colors.power, fontFamily: font.semibold, fontSize: 16 },
  hours: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hour: { minHeight: 48, minWidth: 88, borderRadius: 12, borderWidth: 1, borderColor: colors.lineStrong, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  hourOn: { backgroundColor: colors.power, borderColor: colors.power },
  hourLabel: { color: colors.text, fontFamily: font.semibold, fontSize: 15 },
  hourLabelOn: { color: '#1a1408' },
});
