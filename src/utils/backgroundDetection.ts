import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { loadConfig } from './storage';
import { loadTensorflowModel } from 'react-native-fast-tflite';
import jpeg from 'jpeg-js';
import {
  PERSON_DETECTION_THRESHOLD,
  NOTIFICATION_COOLDOWN_MS,
  NEARNESS_VERY_CLOSE,
  NEARNESS_CLOSE,
} from './constants';

export const BACKGROUND_TASK_NAME = 'doorcam-person-detection';

// Timestamp of last notification — persisted in module scope across bg task runs
let lastNotifiedAt = 0;

TaskManager.defineTask(BACKGROUND_TASK_NAME, async () => {
  try {
    const config = await loadConfig();
    if (!config?.ip) return BackgroundFetch.BackgroundFetchResult.NoData;

    const tempFile = `${FileSystem.cacheDirectory}bg_capture.jpg`;
    await FileSystem.downloadAsync(`http://${config.ip}/capture`, tempFile);

    const resized = await ImageManipulator.manipulateAsync(
      tempFile,
      [{ resize: { width: 300, height: 300 } }],
      { format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );

    const b64 = resized.base64!;
    const binary = atob(b64);
    const jpegBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) jpegBytes[i] = binary.charCodeAt(i);
    const { data: rgba, width, height } = jpeg.decode(jpegBytes, { useTArray: true });
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      rgb[i * 3]     = rgba[i * 4];
      rgb[i * 3 + 1] = rgba[i * 4 + 1];
      rgb[i * 3 + 2] = rgba[i * 4 + 2];
    }

    const model = await loadTensorflowModel(require('../../assets/models/ssd_mobilenet.tflite'));
    const outputs = model.runSync([rgb]);

    const boxes   = outputs[0] as Float32Array;
    const classes = outputs[1] as Float32Array;
    const scores  = outputs[2] as Float32Array;
    const count   = Math.round((outputs[3] as Float32Array)[0]);

    let bestScore = 0;
    let bestBoxH = 0;
    for (let i = 0; i < count; i++) {
      if (classes[i] === 0 && scores[i] > bestScore) {
        bestScore = scores[i];
        const ymin = boxes[i * 4];
        const ymax = boxes[i * 4 + 2];
        bestBoxH = ymax - ymin;
      }
    }

    if (bestScore > PERSON_DETECTION_THRESHOLD) {
      const now = Date.now();
      if (now - lastNotifiedAt > NOTIFICATION_COOLDOWN_MS) {
        lastNotifiedAt = now;
        const nearness =
          bestBoxH > NEARNESS_VERY_CLOSE ? 'very close' :
          bestBoxH > NEARNESS_CLOSE ? 'nearby' : 'far';

        await Notifications.scheduleNotificationAsync({
          content: {
            title: 'Someone at the door',
            body: `Person detected (${nearness}) — ${(bestScore * 100).toFixed(0)}% confidence`,
            priority: Notifications.AndroidNotificationPriority.HIGH,
          },
          trigger: null,
        });
      }
      return BackgroundFetch.BackgroundFetchResult.NewData;
    }

    return BackgroundFetch.BackgroundFetchResult.NoData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function registerBackgroundDetection() {
  await Notifications.requestPermissionsAsync({
    android: { allowAlert: true, allowBadge: true, allowSound: true },
  } as any);

  await Notifications.setNotificationChannelAsync('doorcam', {
    name: 'DoorCam Alerts',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 250, 250, 250],
  });

  const status = await BackgroundFetch.getStatusAsync();
  if (status === BackgroundFetch.BackgroundFetchStatus.Restricted ||
      status === BackgroundFetch.BackgroundFetchStatus.Denied) return;

  await BackgroundFetch.registerTaskAsync(BACKGROUND_TASK_NAME, {
    minimumInterval: 15, // seconds — Android minimum is ~15s
    stopOnTerminate: false,
    startOnBoot: true,
  });
}

export async function unregisterBackgroundDetection() {
  await BackgroundFetch.unregisterTaskAsync(BACKGROUND_TASK_NAME);
}
