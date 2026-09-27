export const colors = {
  page: '#090b0e',
  card: '#10131a',
  cardRaised: '#171c25',
  text: '#f4f1ea',
  muted: '#a8afba',
  faint: '#737b88',
  line: 'rgba(255,255,255,0.08)',
  power: '#f2b84b',
  water: '#62c8e8',
  live: '#ff5b45',
  partial: '#ffb02e',
  good: '#34d399',
  plan: '#7eb0e0',
  idle: '#8b93a0',
};

export const font = {
  text: 'HankenGrotesk_500Medium',
  semibold: 'HankenGrotesk_600SemiBold',
  bold: 'HankenGrotesk_700Bold',
  mono: 'JetBrainsMono_500Medium',
};

export function toneColor(tone: string) {
  if (tone === 'live') return colors.live;
  if (tone === 'partial') return colors.partial;
  if (tone === 'good') return colors.good;
  if (tone === 'plan') return colors.plan;
  return colors.idle;
}

export function toneTint(tone: string) {
  if (tone === 'live') return 'rgba(255,91,69,0.16)';
  if (tone === 'partial') return 'rgba(255,176,46,0.16)';
  if (tone === 'good') return 'rgba(52,211,153,0.16)';
  if (tone === 'plan') return 'rgba(126,176,224,0.16)';
  return 'rgba(139,147,160,0.16)';
}

export function serviceLabel(service: string) {
  return service === 'WATER' ? 'Water' : 'Power';
}
