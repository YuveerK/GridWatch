import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { type ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { placeName } from '@/src/lib/area.js';
import type { Outage } from '@/src/lib/api';
import { statusMeta } from '@/src/lib/status.js';
import { relativeTime } from '@/src/lib/time.js';
import { useApp } from '@/src/state/app';
import { colors, font, serviceLabel, toneColor, toneTint } from '@/src/theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

function detailLine(outage: Outage) {
  const parts: string[] = [];
  const places = outage.localities?.length ?? 0;
  if (places > 1) parts.push(`${places} suburbs`);
  if (outage.sdc) parts.push(outage.sdc.replace(/([a-z])([A-Z])/g, '$1 $2'));
  if (outage.scheduled?.date) {
    const times = outage.scheduled.from && outage.scheduled.to ? ` ${outage.scheduled.from}–${outage.scheduled.to}` : '';
    parts.push(`Scheduled ${outage.scheduled.date}${times}`);
  } else if (outage.eta) {
    parts.push(`ETA ${outage.eta}`);
  }
  if (outage.postCount && outage.postCount > 1) parts.push(`${outage.postCount} posts`);
  return parts.join(' · ');
}

const STATUS_ICON: Record<string, IconName> = {
  alert: 'warning',
  half: 'contrast',
  calendar: 'calendar',
  check: 'checkmark',
  clock: 'time',
  archive: 'archive',
  x: 'close',
};

export function StatusIcon({ name, tone, size = 36 }: { name: string; tone: string; size?: number }) {
  const icon = STATUS_ICON[name] ?? (name as IconName);
  return (
    <View style={[styles.icon, { width: size, height: size, borderRadius: size / 2, backgroundColor: toneTint(tone) }]}>
      <Ionicons name={icon} size={Math.round(size * 0.46)} color={toneColor(tone)} />
    </View>
  );
}

export function Eyebrow({ children }: { children: string }) {
  return <Text style={styles.eyebrow}>{children}</Text>;
}

export function SectionTitle({ title, detail }: { title: string; detail?: string }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {detail ? <Text style={styles.sectionDetail}>{detail}</Text> : null}
    </View>
  );
}

export function Pill({ label, tone }: { label: string; tone: string }) {
  return (
    <View style={[styles.pill, { backgroundColor: toneTint(tone) }]}>
      <View style={[styles.pillDot, { backgroundColor: toneColor(tone) }]} />
      <Text style={[styles.pillText, { color: toneColor(tone) }]}>{label}</Text>
    </View>
  );
}

export function Banner({ children }: { children: string }) {
  return (
    <View style={styles.banner}>
      <Ionicons name="information-circle" size={18} color={colors.power} />
      <Text style={styles.bannerText}>{children}</Text>
    </View>
  );
}

export function Wordmark() {
  return (
    <View style={styles.wordmark}>
      <View style={styles.mark}>
        <Ionicons name="pulse" size={13} color="#1a1408" />
      </View>
      <Text style={styles.wordmarkText}>GridWatch</Text>
    </View>
  );
}

export function ServiceSwitch() {
  const { service, setService } = useApp();
  return (
    <View style={styles.switchRow} accessibilityRole="tablist">
      {(['ELECTRICITY', 'WATER'] as const).map((item) => {
        const on = service === item;
        const accent = item === 'WATER' ? colors.water : colors.power;
        return (
          <Pressable
            key={item}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => setService(item)}
            style={[styles.switchItem, on && { backgroundColor: accent }]}
          >
            <Ionicons name={item === 'WATER' ? 'water' : 'flash'} size={16} color={on ? '#1a1408' : colors.faint} />
            <Text style={[styles.switchLabel, on && styles.switchLabelOn]}>{serviceLabel(item)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function OutageRow({ outage, showService = false }: { outage: Outage; showService?: boolean }) {
  const router = useRouter();
  const service = outage.service ?? 'ELECTRICITY';
  const meta = statusMeta(outage.status, service, outage.waterState);
  const when = relativeTime(outage.lastUpdateAt);
  const place = placeName(outage);
  const summary = outage.latest?.summary?.trim() || outage.cause?.trim() || '';
  const where = outage.municipality?.name || outage.infrastructure?.[0]?.name;
  const detail = detailLine(outage);
  const percent = typeof outage.restorationPercent === 'number' ? outage.restorationPercent : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${place}, ${meta.label}, ${when}`}
      onPress={() => router.push({ pathname: '/outage/[id]', params: { id: outage.id } })}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rowTop}>
        <StatusIcon name={meta.icon} tone={meta.tone} />
        <View style={styles.rowBody}>
          <Text style={styles.rowTitle} numberOfLines={2}>{place}</Text>
          {outage.title && outage.title !== place ? <Text style={styles.rowSub} numberOfLines={1}>{outage.title}</Text> : null}
          {where ? <Text style={styles.rowSub} numberOfLines={1}>{where}</Text> : null}
          {detail ? <Text style={styles.rowSub} numberOfLines={2}>{detail}</Text> : null}
          {summary ? <Text style={styles.rowSummary} numberOfLines={2}>{summary}</Text> : null}
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.faint} />
      </View>
      <View style={styles.rowFoot}>
        <Pill label={showService ? `${serviceLabel(service)} · ${meta.label}` : meta.label} tone={meta.tone} />
        <Text style={styles.rowTime}>{when}</Text>
      </View>
      {percent != null && (
        <View style={styles.meter}>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${Math.max(0, Math.min(100, percent))}%`, backgroundColor: toneColor(meta.tone) }]} />
          </View>
          <Text style={styles.percent}>{percent}%</Text>
        </View>
      )}
    </Pressable>
  );
}

export function PrimaryButton({ label, onPress, icon }: { label: string; onPress: () => void; icon?: IconName }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
      {icon ? <Ionicons name={icon} size={18} color="#1a1408" /> : null}
      <Text style={styles.primaryLabel}>{label}</Text>
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress, icon }: { label: string; onPress: () => void; icon?: IconName }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
      {icon ? <Ionicons name={icon} size={18} color={colors.text} /> : null}
      <Text style={styles.secondaryLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  icon: { alignItems: 'center', justifyContent: 'center' },
  eyebrow: { color: colors.faint, fontFamily: font.semibold, fontSize: 11, letterSpacing: 1.4, textTransform: 'uppercase' },
  section: { gap: 4, marginTop: 6 },
  sectionTitle: { color: colors.text, fontFamily: font.bold, fontSize: 18, letterSpacing: -0.3 },
  sectionDetail: { color: colors.muted, fontFamily: font.text, fontSize: 14, lineHeight: 20 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { fontFamily: font.semibold, fontSize: 12 },
  banner: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', backgroundColor: colors.cardRaised, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: colors.line },
  bannerText: { flex: 1, color: colors.text, fontFamily: font.text, fontSize: 14, lineHeight: 20 },
  wordmark: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mark: { width: 24, height: 24, borderRadius: 8, backgroundColor: colors.power, alignItems: 'center', justifyContent: 'center' },
  wordmarkText: { color: colors.text, fontFamily: font.bold, fontSize: 15, letterSpacing: -0.2 },
  switchRow: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: 16, padding: 4, gap: 4, borderWidth: 1, borderColor: colors.line },
  switchItem: { flex: 1, minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  switchLabel: { color: colors.faint, fontFamily: font.semibold, fontSize: 15 },
  switchLabelOn: { color: '#1a1408' },
  row: { backgroundColor: colors.card, borderRadius: 18, padding: 14, gap: 12, borderWidth: 1, borderColor: colors.line, marginBottom: 10 },
  pressed: { opacity: 0.82 },
  rowTop: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  rowBody: { flex: 1, gap: 3 },
  rowTitle: { color: colors.text, fontFamily: font.bold, fontSize: 17, letterSpacing: -0.3 },
  rowSub: { color: colors.muted, fontFamily: font.text, fontSize: 13 },
  rowSummary: { color: colors.muted, fontFamily: font.text, fontSize: 14, lineHeight: 20, marginTop: 2 },
  rowFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  rowTime: { color: colors.faint, fontFamily: font.mono, fontSize: 12 },
  meter: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  track: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.cardRaised, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  percent: { color: colors.muted, fontFamily: font.mono, fontSize: 12, minWidth: 36, textAlign: 'right' },
  primary: { minHeight: 52, borderRadius: 16, backgroundColor: colors.power, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
  primaryLabel: { color: '#1a1408', fontFamily: font.bold, fontSize: 16, lineHeight: 22, flexShrink: 0, paddingRight: 4 },
  secondary: { minHeight: 52, borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
  secondaryLabel: { color: colors.text, fontFamily: font.semibold, fontSize: 16, lineHeight: 22, flexShrink: 0, paddingRight: 4 },
});
