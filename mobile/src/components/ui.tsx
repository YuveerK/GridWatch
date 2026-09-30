import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { type ComponentProps } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { placeName } from '@/src/lib/area.js';
import type { Outage } from '@/src/lib/api';
import { statusMeta } from '@/src/lib/status.js';
import { relativeTime } from '@/src/lib/time.js';
import { useApp } from '@/src/state/app';
import { colors, font, serviceLabel, toneColor, toneTint } from '@/src/theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

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

export function Banner({ children, tone = 'info', action }: { children: string; tone?: 'info' | 'warning' | 'error'; action?: { label: string; onPress: () => void } }) {
  const icon = tone === 'error' ? 'alert-circle' : tone === 'warning' ? 'warning' : 'information-circle';
  const color = tone === 'error' ? colors.live : tone === 'warning' ? colors.partial : colors.power;
  return (
    <View style={styles.banner}>
      <Ionicons name={icon} size={18} color={color} />
      <View style={styles.bannerBody}>
        <Text style={styles.bannerText}>{children}</Text>
        {action ? (
          <Pressable accessibilityRole="button" onPress={action.onPress} style={styles.bannerAction}>
            <Text style={styles.bannerActionLabel}>{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function Wordmark() {
  return (
    <View style={styles.wordmark}>
      <Image source={require('../../assets/images/icon.png')} style={styles.markImage} accessibilityIgnoresInvertColors />
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
  const summary = outage.latest?.summary?.trim() || '';
  const support = supportFact(outage);
  const percent = typeof outage.restorationPercent === 'number' ? outage.restorationPercent : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${place}, ${meta.label}, updated ${when}`}
      onPress={() => router.push({ pathname: '/outage/[id]', params: { id: outage.id } })}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={[styles.accent, { backgroundColor: toneColor(meta.tone) }]} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          {showService ? <Ionicons name={service === 'WATER' ? 'water' : 'flash'} size={16} color={service === 'WATER' ? colors.water : colors.power} /> : null}
          <Text style={styles.rowTitle} numberOfLines={2}>{place}</Text>
        </View>
        <Pill label={meta.label} tone={meta.tone} />
        {summary ? <Text style={styles.rowSummary} numberOfLines={2}>{summary}</Text> : null}
        {support ? <Text style={styles.rowSub} numberOfLines={2}>{support}</Text> : null}
        <Text style={styles.rowTime}>Updated {when}</Text>
        {percent != null && (
          <View style={styles.meter}>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.max(0, Math.min(100, percent))}%`, backgroundColor: toneColor(meta.tone) }]} />
            </View>
            <Text style={styles.percent}>Reported {percent}%</Text>
          </View>
        )}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.faint} />
    </Pressable>
  );
}

function supportFact(outage: Outage) {
  if (outage.scheduled?.date) {
    const times = outage.scheduled.from && outage.scheduled.to ? ` ${outage.scheduled.from}–${outage.scheduled.to}` : '';
    return `Scheduled ${outage.scheduled.date}${times}`;
  }
  if (outage.eta) return `ETA ${outage.eta}`;
  const places = outage.localities?.length ?? 0;
  if (places > 1) return `${places} suburbs named`;
  return null;
}

export function PrimaryButton({ label, onPress, icon, busy = false, disabled = false }: { label: string; onPress: () => void; icon?: IconName; busy?: boolean; disabled?: boolean }) {
  const off = busy || disabled;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: off, busy }} disabled={off} onPress={onPress} style={({ pressed }) => [styles.primary, off && styles.disabled, pressed && !off && styles.pressed]}>
      {icon && !busy ? <Ionicons name={icon} size={18} color="#1a1408" /> : null}
      <Text style={styles.primaryLabel}>{busy ? 'Working…' : label}</Text>
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress, icon, busy = false, disabled = false }: { label: string; onPress: () => void; icon?: IconName; busy?: boolean; disabled?: boolean }) {
  const off = busy || disabled;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: off, busy }} disabled={off} onPress={onPress} style={({ pressed }) => [styles.secondary, off && styles.disabled, pressed && !off && styles.pressed]}>
      {icon && !busy ? <Ionicons name={icon} size={18} color={colors.text} /> : null}
      <Text style={styles.secondaryLabel}>{busy ? 'Working…' : label}</Text>
    </Pressable>
  );
}

export function IconButton({ label, icon, onPress }: { label: string; icon: IconName; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.iconButton}>
      <Ionicons name={icon} size={22} color={colors.text} />
    </Pressable>
  );
}

function Bone({ width, height, radius = 8 }: { width: number | `${number}%`; height: number; radius?: number }) {
  return <View style={{ width, height, borderRadius: radius, backgroundColor: colors.cardRaised }} />;
}

/** A static placeholder shaped like a real row, shown only while that row's own data is loading. No pulsing: this app avoids perpetual motion that implies a live feed. */
export function OutageRowSkeleton() {
  return (
    <View style={[styles.row, styles.skeletonRow]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.accent, { backgroundColor: colors.line }]} />
      <View style={styles.rowBody}>
        <Bone width="70%" height={17} />
        <View style={styles.skeletonGap}>
          <Bone width={84} height={20} radius={999} />
        </View>
        <Bone width="92%" height={14} />
        <View style={styles.skeletonGap}>
          <Bone width={110} height={12} />
        </View>
      </View>
    </View>
  );
}

export function OutageListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <View accessibilityLabel="Loading incidents" accessibilityRole="progressbar">
      {Array.from({ length: rows }, (_, index) => <OutageRowSkeleton key={index} />)}
    </View>
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
  pillText: { flexShrink: 1, fontFamily: font.semibold, fontSize: 12 },
  banner: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', backgroundColor: colors.cardRaised, borderRadius: 16, padding: 14 },
  bannerBody: { flex: 1, gap: 8 },
  bannerText: { color: colors.text, fontFamily: font.text, fontSize: 14, lineHeight: 20 },
  bannerAction: { minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start' },
  bannerActionLabel: { color: colors.power, fontFamily: font.semibold, fontSize: 15 },
  wordmark: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  markImage: { width: 24, height: 24, borderRadius: 6 },
  wordmarkText: { color: colors.text, fontFamily: font.bold, fontSize: 15, letterSpacing: -0.2 },
  switchRow: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: 16, padding: 4, gap: 4, borderWidth: 1, borderColor: colors.line },
  switchItem: { flex: 1, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  switchLabel: { color: colors.faint, fontFamily: font.semibold, fontSize: 15 },
  switchLabelOn: { color: '#1a1408' },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: 16, paddingVertical: 12, paddingRight: 12, gap: 8, marginBottom: 10, overflow: 'hidden' },
  accent: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
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
  primary: { minHeight: 48, borderRadius: 12, backgroundColor: colors.power, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
  primaryLabel: { color: '#1a1408', fontFamily: font.bold, fontSize: 16, lineHeight: 22, flexShrink: 1, paddingRight: 4 },
  secondary: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
  secondaryLabel: { color: colors.text, fontFamily: font.semibold, fontSize: 16, lineHeight: 22, flexShrink: 1, paddingRight: 4 },
  disabled: { opacity: 0.45 },
  iconButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  skeletonRow: { alignItems: 'stretch' },
  skeletonGap: { marginTop: 4 },
});
