import { Stack } from 'expo-router/js-stack';
import { stackScreenOptions } from '@/src/navigation';

export default function MapLayout() {
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="index" options={{ title: 'Map' }} />
    </Stack>
  );
}
