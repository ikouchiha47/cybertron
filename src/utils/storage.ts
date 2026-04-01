import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'doorcam_config';

export interface CamConfig {
  ip: string;
}

export async function saveConfig(config: CamConfig): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(config));
}

export async function loadConfig(): Promise<CamConfig | null> {
  const raw = await AsyncStorage.getItem(KEY);
  return raw ? JSON.parse(raw) : null;
}
