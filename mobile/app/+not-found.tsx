import { Link, Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { colors, font, reading } from '@/src/theme';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <View style={styles.container}>
        <Text style={styles.title}>This screen does not exist.</Text>
        <Text style={styles.body}>The link may be out of date. My area is still available.</Text>
        <Link href="/" style={styles.link} accessibilityRole="link">
          <Text style={styles.linkText}>Back to my area</Text>
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { ...reading, flex: 1, justifyContent: 'center', padding: 20, gap: 8, backgroundColor: colors.page },
  title: { fontFamily: font.bold, fontSize: 28, lineHeight: 34, color: colors.text },
  body: { fontFamily: font.text, fontSize: 16, lineHeight: 22, color: colors.muted },
  link: { minHeight: 48, justifyContent: 'center' },
  linkText: { fontFamily: font.semibold, fontSize: 16, color: colors.power },
});
