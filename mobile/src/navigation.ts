import { TransitionPresets } from 'expo-router/js-stack';
import { colors, font } from '@/src/theme';

export const stackScreenOptions = {
  ...TransitionPresets.SlideFromRightIOS,
  gestureEnabled: true,
  cardStyle: { backgroundColor: colors.page },
  headerStyle: { backgroundColor: colors.page },
  headerTintColor: colors.text,
  headerTitleStyle: { color: colors.text, fontFamily: font.semibold, fontSize: 17 },
  headerShadowVisible: false,
};
