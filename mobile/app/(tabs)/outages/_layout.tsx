import { Stack } from 'expo-router/js-stack';
import { stackScreenOptions } from '@/src/navigation';

export default function OutagesLayout() {
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="index" options={{ title: 'Outages' }} />
      <Stack.Screen name="search" options={{ title: 'Search' }} />
    </Stack>
  );
}
