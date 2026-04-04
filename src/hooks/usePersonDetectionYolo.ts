import { useEffect, useRef, useState } from 'react';
import { NativeEventEmitter, NativeModules } from 'react-native';
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
  NEARNESS_VERY_CLOSE,
  NEARNESS_CLOSE,
} from '../utils/constants';

const QUEUE_SIZE = 4;
const YOLO_SIZE  = 320;

interface PersonCandidate {
  score: number;
  boxH: number;
}

interface DetectionResult {
  personCount: number;
  nearness: 'none' | 'far' | 'close' | 'very_close';
  candidates: PersonCandidate[];
}

/**
 * Resize + decode JPEG to float32 RGB [0,1] at 320×320 for YOLOv8.
 */
async function prepareInput(base64Jpeg: string, tempFile: string): Promise<Float32Array> {
  await FileSystem.writeAsStringAsync(tempFile, base64Jpeg, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const resized = await ImageManipulator.manipulateAsync(
    tempFile,
    [{ resize: { width: YOLO_SIZE, height: YOLO_SIZE } }],
    { format: ImageManipulator.SaveFormat.JPEG, base64: true },
  );

  const b64 = resized.base64!;
  const bin = atob(b64);
  const jpegBytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) jpegBytes[i] = bin.charCodeAt(i);

  const { data: rgba, width, height } = jpeg.decode(jpegBytes, { useTArray: true });
  const float32 = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    float32[i * 3]     = rgba[i * 4]     / 255.0;
    float32[i * 3 + 1] = rgba[i * 4 + 1] / 255.0;
    float32[i * 3 + 2] = rgba[i * 4 + 2] / 255.0;
  }
  return float32;
}

/**
 * Parse YOLOv8n output tensor.
 *
 * onnx2tf keeps the original ONNX layout [1, 84, 2100] (no channel-last transpose
 * for non-spatial outputs).  Row-major in memory: row r, col i → raw[r*2100 + i].
 *   row 0: cx   (pixels 0-320)
 *   row 1: cy
 *   row 2: w
 *   row 3: h
 *   row 4: person score (class 0, sigmoid applied in model, range 0-1)
 *   row 5-83: other 79 COCO class scores
 */
function parseOutput(raw: Float32Array, minScore: number): PersonCandidate[] {
  const numDet  = 2100;
  const hRow    = 3;   // row index for box height
  const pRow    = 4;   // row index for person score
  const candidates: PersonCandidate[] = [];

  for (let i = 0; i < numDet; i++) {
    const personScore = raw[pRow * numDet + i];
    if (personScore >= minScore) {
      const hNorm = raw[hRow * numDet + i] / YOLO_SIZE;
      candidates.push({ score: personScore, boxH: hNorm });
    }
  }
  return candidates;
}

export function usePersonDetectionYolo() {
  const model = useTensorflowModel(require('../../assets/models/yolov8n.tflite'));
  const [result, setResult] = useState<DetectionResult>({ personCount: 0, nearness: 'none', candidates: [] });
  const [inferring, setInferring] = useState(false);

  const queueRef     = useRef<string[]>([]);
  const busyRef      = useRef(false);
  const emptyFrames  = useRef(0);
  const personActive = useRef(false);
  const notifiedRef  = useRef(false);
  const tempFile = `${FileSystem.cacheDirectory}capture_yolo.jpg`;

  // Setup notifications once
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

  // Listen for frames emitted by the native bridge
  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.RCTDeviceEventEmitter);
    const sub = emitter.addListener('MjpegFrame', (event: { base64: string }) => {
      const q = queueRef.current;
      if (q.length >= QUEUE_SIZE) q.shift();
      q.push(event.base64);
    });
    return () => sub.remove();
  }, []);

  // Inference loop
  useEffect(() => {
    if (model.state !== 'loaded') return;

    let alive = true;

    const loop = async () => {
      while (alive) {
        const q = queueRef.current;
        if (q.length === 0 || busyRef.current) {
          await sleep(50);
          continue;
        }

        const base64 = q.shift()!;
        busyRef.current = true;
        setInferring(true);

        try {
          const input      = await prepareInput(base64, tempFile);
          const outputs    = model.model!.runSync([input]);
          const raw        = outputs[0] as Float32Array;
          const candidates = parseOutput(raw, PERSON_CANDIDATE_MIN_SCORE);

          let bestScore = 0;
          let bestBoxH  = 0;
          for (const c of candidates) {
            console.log(`[DoorCam/yolo] score=${c.score.toFixed(3)} boxH=${c.boxH.toFixed(2)}`);
            if (c.score > bestScore) { bestScore = c.score; bestBoxH = c.boxH; }
          }

          const personCount  = bestScore >= PERSON_DETECTION_THRESHOLD ? 1 : 0;
          const maxBoxHeight = personCount > 0 ? bestBoxH : 0;
          console.log('[DoorCam/yolo] best score:', bestScore.toFixed(3), 'detected:', personCount);

          const nearness: DetectionResult['nearness'] =
            personCount === 0                    ? 'none'
            : maxBoxHeight > NEARNESS_VERY_CLOSE ? 'very_close'
            : maxBoxHeight > NEARNESS_CLOSE      ? 'close'
            : 'far';

          if (personCount > 0) {
            emptyFrames.current = 0;
            personActive.current = true;
            setResult({ personCount, nearness, candidates });
          } else {
            emptyFrames.current += 1;
            if (emptyFrames.current >= EMPTY_FRAMES_BEFORE_RESET) {
              personActive.current = false;
              setResult({ personCount: 0, nearness: 'none', candidates });
            }
          }

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
          console.warn('[DoorCam/yolo] inference error:', e);
        }

        busyRef.current = false;
        setInferring(false);
      }
    };

    loop();
    return () => { alive = false; };
  }, [model.state]);

  return { result, modelReady: model.state === 'loaded', inferring };
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}
