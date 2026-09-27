import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack } from 'expo-router/js-stack';
import { Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { stackScreenOptions } from '@/src/navigation';
import { colors } from '@/src/theme';

export default function OutagesLayout() {
  const router = useRouter();
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen
        name="index"
        options={{
          title: 'Outages',
          headerRight: () => (
            <Pressable accessibilityRole="button" accessibilityLabel="Search" onPress={() => router.push('/outages/search')} hitSlop={8}>
              <Ionicons name="search" size={22} color={colors.power} />
            </Pressable>
          ),
        }}
      />
      <Stack.Screen name="search" options={{ title: 'Search' }} />
    </Stack>
  );
}
