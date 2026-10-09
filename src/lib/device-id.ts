/**
 * Stable device id — the server keys notification configs and private alert
 * topics by it. Generated once, kept in AsyncStorage, never changes after.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'paper.deviceId.v1';

export async function getDeviceId(): Promise<string> {
  try {
    const stored = await AsyncStorage.getItem(KEY);
    if (stored) return stored;
    const fresh = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    await AsyncStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}
