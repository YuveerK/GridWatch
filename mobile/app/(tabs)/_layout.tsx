import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router/js-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, font } from '@/src/theme';

const TAB_BODY = 56;

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.page },
        headerTintColor: colors.text,
        headerTitleAlign: 'left',
        headerTitleContainerStyle: { maxWidth: 9999 },
        headerTitleStyle: { color: colors.text, fontFamily: font.semibold, fontWeight: '400' },
        headerShadowVisible: false,
        tabBarStyle: {
          backgroundColor: '#111418',
          borderTopColor: colors.line,
          height: TAB_BODY + insets.bottom,
          paddingTop: 6,
          paddingBottom: insets.bottom,
        },
        tabBarLabelStyle: { fontFamily: font.semibold, fontSize: 11, letterSpacing: 0.2 },
        tabBarActiveTintColor: colors.power,
        tabBarInactiveTintColor: colors.faint,
        sceneStyle: { backgroundColor: colors.page },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'My area',
          tabBarIcon: ({ color, size, focused }) => <Ionicons name={focused ? 'home' : 'home-outline'} size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="outages"
        options={{
          title: 'Outages',
          headerShown: false,
          tabBarIcon: ({ color, size, focused }) => <Ionicons name={focused ? 'list' : 'list-outline'} size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="map"
        options={{
          title: 'Map',
          headerShown: false,
          tabBarIcon: ({ color, size, focused }) => <Ionicons name={focused ? 'map' : 'map-outline'} size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="following"
        options={{
          title: 'Following',
          headerShown: false,
          tabBarIcon: ({ color, size, focused }) => <Ionicons name={focused ? 'heart' : 'heart-outline'} size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
