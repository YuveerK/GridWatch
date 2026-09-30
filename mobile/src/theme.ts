export const colors = {
  page: '#0B1016',
  card: '#141D28',
  cardRaised: '#1D2A38',
  text: '#F5F3ED',
  muted: '#B6C0CD',
  faint: '#97A4B5',
  line: 'rgba(245,243,237,0.10)',
  lineStrong: 'rgba(245,243,237,0.22)',
  power: '#F4BE58',
  water: '#6DD5F2',
  live: '#FF7969',
  partial: '#F3BE63',
  good: '#62D5AD',
  plan: '#A1BFFF',
  idle: '#A7B2C2',
};

export const font = {
  text: 'HankenGrotesk_500Medium',
  semibold: 'HankenGrotesk_600SemiBold',
  bold: 'HankenGrotesk_700Bold',
  mono: 'JetBrainsMono_500Medium',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 };

/** Keeps long reading screens from stretching across a tablet. Maps stay full width. */
export const reading = { width: '100%' as const, maxWidth: 720, alignSelf: 'center' as const };

export function toneColor(tone: string) {
  if (tone === 'live') return colors.live;
  if (tone === 'partial') return colors.partial;
  if (tone === 'good') return colors.good;
  if (tone === 'plan') return colors.plan;
  return colors.idle;
}

export function toneTint(tone: string) {
  if (tone === 'live') return 'rgba(255,121,105,0.16)';
  if (tone === 'partial') return 'rgba(243,190,99,0.16)';
  if (tone === 'good') return 'rgba(98,213,173,0.16)';
  if (tone === 'plan') return 'rgba(161,191,255,0.16)';
  return 'rgba(167,178,194,0.14)';
}

export function serviceLabel(service: string) {
  return service === 'WATER' ? 'Water' : 'Power';
}

export function serviceColor(service: string) {
  return service === 'WATER' ? colors.water : colors.power;
}
