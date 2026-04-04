import { useEffect, useRef, useState } from 'react';
import { NativeEventEmitter, NativeModules } from 'react-native';
import { useTensorflowModel } from 'react-native-fast-tflite';
import * as Notifications from 'expo-notifications';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import jpeg from 'jpeg-js';
import {
  PERSON_DETECTION_THRESHOLD,
  EMPTY_FRAMES_BEFORE_RESET,
  NOTIFICATION_COOLDOWN_MS,
  NEARNESS_VERY_CLOSE,
  NEARNESS_CLOSE,
} from '../utils/constants';

const QUEUE_SIZE = 4;

interface PersonCandidate {
  score: number;
  boxH: number;
}

interface DetectionResult {
  personCount: number;
  nearness: 'none' | 'far' | 'close' | 'very_close';
  candidates: PersonCandidate[];
}

async function prepareInput(base64Jpeg: string, tempFile: string): Promise<Uint8Array> {
  await FileSystem.writeAsStringAsync(tempFile, base64Jpeg, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const resized = await ImageManipulator.manipulateAsync(
    tempFile,
    [{ resize: { width: 300, height: 300 } }],
    { format: ImageManipulator.SaveFormat.JPEG, base64: true },
  );

  const b64 = resized.base64!;
  const bin = atob(b64);
  const jpegBytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) jpegBytes[i] = bin.charCodeAt(i);

  const { data: rgba, width, height } = jpeg.decode(jpegBytes, { useTArray: true });
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3]     = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return rgb;
}

export function usePersonDetection(gammaOn = false) {
  const model = useTensorflowModel(require('../../assets/models/ssd_mobilenet.tflite'));
  const [result, setResult] = useState<DetectionResult>({ personCount: 0, nearness: 'none', candidates: [] });
  const [inferring, setInferring] = useState(false);

  const queueRef     = useRef<string[]>([]); // base64 JPEG strings
  const busyRef      = useRef(false);
  const emptyFrames  = useRef(0);
  const personActive = useRef(false);
  const notifiedRef  = useRef(false);
  const tempFile = `${FileSystem.cacheDirectory}capture.jpg`;

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
          const inputRgb = await prepareInput(base64, tempFile);
          const outputs  = model.model!.runSync([inputRgb]);

          const boxes   = outputs[0] as Float32Array;
          const classes = outputs[1] as Float32Array;
          const scores  = outputs[2] as Float32Array;
          const count   = Math.round((outputs[3] as Float32Array)[0]);

          const candidates: PersonCandidate[] = [];
          let bestScore = 0;
          let bestBoxH  = 0;

          for (let i = 0; i < count; i++) {
            if (classes[i] === 0) {
              const ymin = boxes[i * 4];
              const ymax = boxes[i * 4 + 2];
              const h    = ymax - ymin;
              candidates.push({ score: scores[i], boxH: h });
              console.log(`[DoorCam] candidate i=${i} score=${scores[i].toFixed(3)} boxH=${h.toFixed(2)}`);
              if (scores[i] > bestScore) { bestScore = scores[i]; bestBoxH = h; }
            }
          }

          // Lower threshold at night (gamma on) — IR images score lower
          const threshold    = gammaOn ? PERSON_DETECTION_THRESHOLD * 0.65 : PERSON_DETECTION_THRESHOLD;
          const personCount  = bestScore > threshold ? 1 : 0;
          const maxBoxHeight = personCount > 0 ? bestBoxH : 0;
          console.log('[DoorCam] best score:', bestScore.toFixed(3), 'detected:', personCount);

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
          console.warn('[DoorCam] inference error:', e);
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
