import 'react-native-gesture-handler';
import { LogBox, Platform, StyleSheet } from 'react-native';
import { Stack } from 'expo-router/js-stack';
import { useRouter } from 'expo-router';
import { useFonts } from 'expo-font';
import {
  HankenGrotesk_500Medium,
  HankenGrotesk_600SemiBold,
  HankenGrotesk_700Bold,
} from '@expo-google-fonts/hanken-grotesk';
import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { stackScreenOptions } from '@/src/navigation';
import { AppState, useApp } from '@/src/state/app';

LogBox.ignoreLogs(['InteractionManager has been deprecated']);

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

SplashScreen.preventAutoHideAsync().catch(() => undefined);

if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

function NotificationLink() {
  const router = useRouter();
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const id = response.notification.request.content.data?.outageId;
      if (typeof id === 'string' && id) router.push({ pathname: '/outage/[id]', params: { id } });
    });
    return () => sub.remove();
  }, [router]);
  return null;
}

function ReadyGate({ children }: { children: React.ReactNode }) {
  const { ready } = useApp();
  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);
  if (!ready) return null;
  return children;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    HankenGrotesk_500Medium,
    HankenGrotesk_600SemiBold,
    HankenGrotesk_700Bold,
    JetBrainsMono_500Medium,
  });
  if (!fontsLoaded && !fontError) return null;
  return (
    <GestureHandlerRootView style={styles.root}>
      <AppState>
        <ReadyGate>
          <StatusBar style="light" />
          <NotificationLink />
          <Stack screenOptions={stackScreenOptions}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="outage/[id]" options={{ title: 'Incident' }} />
            <Stack.Screen name="suburb/[id]" options={{ title: 'Suburb' }} />
          </Stack>
        </ReadyGate>
      </AppState>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#090b0e' },
});
