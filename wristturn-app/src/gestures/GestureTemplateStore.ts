import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Point3D } from "./recognizer/PointCloudRecognizer";

const KEY = "gesture_templates_v1";

export interface CapturedTemplate {
  gesture: string;
  points: Point3D[];  // raw (un-normalized) — normalizer runs at recognize time
  capturedAt: number;
}

export interface TemplateStore {
  version: 1;
  templates: CapturedTemplate[];
}

export const GestureTemplateStore = {
  async load(): Promise<CapturedTemplate[]> {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    try {
      const store: TemplateStore = JSON.parse(raw);
      return store.version === 1 ? store.templates : [];
    } catch {
      return [];
    }
  },

  async save(templates: CapturedTemplate[]): Promise<void> {
    const store: TemplateStore = { version: 1, templates };
    await AsyncStorage.setItem(KEY, JSON.stringify(store));
  },

  async append(template: CapturedTemplate): Promise<void> {
    const existing = await this.load();
    await this.save([...existing, template]);
  },

  async clear(): Promise<void> {
    await AsyncStorage.removeItem(KEY);
  },

  async hasCalibration(): Promise<boolean> {
    const t = await this.load();
    return t.length > 0;
  },
};
