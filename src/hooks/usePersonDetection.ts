import { useEffect, useRef, useState } from 'react';
import { useTensorflowModel } from 'react-native-fast-tflite';
import * as Notifications from 'expo-notifications';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import jpeg from 'jpeg-js';
import {
  PERSON_DETECTION_THRESHOLD,
  PERSON_CANDIDATE_MIN_SCORE,
  EMPTY_FRAMES_BEFORE_RESET,
  NOTIFICATION_COOLDOWN_MS,
  DETECTION_INTERVAL_MS,
  NEARNESS_VERY_CLOSE,
  NEARNESS_CLOSE,
} from '../utils/constants';

interface PersonCandidate {
  score: number;
  boxH: number;
}

interface DetectionResult {
  personCount: number;
  nearness: 'none' | 'far' | 'close' | 'very_close';
  candidates: PersonCandidate[];
}

// Fetch JPEG from ESP32, resize to 300x300, decode to raw uint8 RGB tensor
async function prepareInput(ip: string, tempFile: string): Promise<Uint8Array> {
  await FileSystem.downloadAsync(`http://${ip}/capture`, tempFile);

  // Resize to 300x300 and get base64 JPEG
  const resized = await ImageManipulator.manipulateAsync(
    tempFile,
    [{ resize: { width: 300, height: 300 } }],
    { format: ImageManipulator.SaveFormat.JPEG, base64: true }
  );

  // Decode base64 → JPEG bytes
  const b64 = resized.base64!;
  const binary = atob(b64);
  const jpegBytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) jpegBytes[i] = binary.charCodeAt(i);

  // Decode JPEG → raw RGBA pixels [300*300*4]
  const { data: rgba, width, height } = jpeg.decode(jpegBytes, { useTArray: true });

  // Extract RGB (drop Alpha channel) → [300*300*3]
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3]     = rgba[i * 4];     // R
    rgb[i * 3 + 1] = rgba[i * 4 + 1]; // G
    rgb[i * 3 + 2] = rgba[i * 4 + 2]; // B
  }
  return rgb;
}

export function usePersonDetection(ip: string | null, intervalMs = DETECTION_INTERVAL_MS) {
  const model = useTensorflowModel(require('../../assets/models/ssd_mobilenet.tflite'));
  const [result, setResult] = useState<DetectionResult>({ personCount: 0, nearness: 'none', candidates: [] });
  const [inferring, setInferring] = useState(false);
  const notifiedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const emptyFrames = useRef(0);
  const tempFile = `${FileSystem.cacheDirectory}capture.jpg`;

  useEffect(() => {
    Notifications.requestPermissionsAsync();
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowList: true,
      }),
    });
    Notifications.setNotificationChannelAsync('doorcam', {
      name: 'DoorCam Alerts',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      vibrationPattern: [0, 250, 250, 250],
    });
  }, []);

  useEffect(() => {
    if (!ip || model.state !== 'loaded') return;

    timerRef.current = setInterval(async () => {
      try {
        const inputRgb = await prepareInput(ip, tempFile);
        setInferring(true);

        // Model input: uint8 [1, 300, 300, 3] — pass flat [270000] Uint8Array
        const outputs = model.model!.runSync([inputRgb]);

        // SSD MobileNet v1 outputs:
        // [0] boxes   [1,10,4]  — [ymin,xmin,ymax,xmax] normalized 0-1
        // [1] classes [1,10]    — class index (0 = person in COCO)
        // [2] scores  [1,10]    — confidence
        // [3] count   [1]
        const boxes   = outputs[0] as Float32Array;
        const classes = outputs[1] as Float32Array;
        const scores  = outputs[2] as Float32Array;
        const count   = Math.round((outputs[3] as Float32Array)[0]);

        // Collect all class=0 detections for display, find the single best one
        const candidates: PersonCandidate[] = [];
        let bestScore = 0;
        let bestBoxH = 0;

        for (let i = 0; i < count; i++) {
          if (classes[i] === 0) {
            const ymin = boxes[i * 4];
            const ymax = boxes[i * 4 + 2];
            const h = ymax - ymin;
            candidates.push({ score: scores[i], boxH: h });
            console.log(`[DoorCam] person candidate i=${i} score=${scores[i].toFixed(3)} boxH=${h.toFixed(2)}`);
            if (scores[i] > bestScore) {
              bestScore = scores[i];
              bestBoxH = h;
            }
          }
        }

        // Only count as detected if best score clears threshold
        const personCount = bestScore > PERSON_DETECTION_THRESHOLD ? 1 : 0;
        const maxBoxHeight = personCount > 0 ? bestBoxH : 0;
        console.log('[DoorCam] best score:', bestScore.toFixed(3), 'detected:', personCount);

        const nearness: DetectionResult['nearness'] =
          personCount === 0    ? 'none'
          : maxBoxHeight > NEARNESS_VERY_CLOSE ? 'very_close'
          : maxBoxHeight > NEARNESS_CLOSE ? 'close'
          : 'far';

        if (personCount > 0) {
          emptyFrames.current = 0;
          setResult({ personCount, nearness, candidates });
        } else {
          emptyFrames.current += 1;
          if (emptyFrames.current >= EMPTY_FRAMES_BEFORE_RESET) {
            setResult({ personCount: 0, nearness: 'none', candidates });
          }
        }
        setInferring(false);

        if (personCount > 0 && !notifiedRef.current) {
          notifiedRef.current = true;
          await Notifications.scheduleNotificationAsync({
            content: {
              title: 'Someone at the door',
              body: `${personCount} person${personCount > 1 ? 's' : ''} detected`,
              sound: 'default',
            },
            trigger: { channelId: 'doorcam' },
          });
          setTimeout(() => { notifiedRef.current = false; }, NOTIFICATION_COOLDOWN_MS);
        }
      } catch (e) {
        console.log('[DoorCam] error:', e);
        setInferring(false);
      }
    }, intervalMs);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [ip, model.state, intervalMs]);

  return { result, modelReady: model.state === 'loaded', inferring };
}
