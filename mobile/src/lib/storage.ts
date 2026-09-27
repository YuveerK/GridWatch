import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'gridwatch.cache.';

export type CacheEntry<T> = { savedAt: number; data: T };

export async function readCache<T>(name: string): Promise<CacheEntry<T> | null> {
  const raw = await AsyncStorage.getItem(PREFIX + name);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (!parsed || typeof parsed.savedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeCache<T>(name: string, data: T) {
  const entry: CacheEntry<T> = { savedAt: Date.now(), data };
  await AsyncStorage.setItem(PREFIX + name, JSON.stringify(entry));
}
