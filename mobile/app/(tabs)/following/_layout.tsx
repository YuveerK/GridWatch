import { Stack } from 'expo-router/js-stack';
import { stackScreenOptions } from '@/src/navigation';

export default function FollowingLayout() {
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="index" options={{ title: 'Following' }} />
      <Stack.Screen name="quiet" options={{ title: 'Quiet hours' }} />
    </Stack>
  );
}
