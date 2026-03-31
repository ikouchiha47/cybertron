import { requireNativeModule, EventEmitter } from "expo-modules-core";

const native = requireNativeModule("AndroidTV");
const emitter = new EventEmitter<{ onSecret: []; onReady: []; onError: [{ message: string }] }>(native);

export const KeyCode = {
  DPAD_UP:          19,
  DPAD_DOWN:        20,
  DPAD_LEFT:        21,
  DPAD_RIGHT:       22,
  DPAD_CENTER:      23,
  BACK:             4,
  HOME:             3,
  VOLUME_UP:        24,
  VOLUME_DOWN:      25,
  MUTE:             164,
  MEDIA_PLAY_PAUSE: 85,
  MEDIA_NEXT:       87,
  MEDIA_PREV:       88,
  MEDIA_FF:         90,
  MEDIA_REWIND:     89,
  NETFLIX:          286,
  YOUTUBE:          176,
  AMAZON:           178,
} as const;

export const AppLink = {
  Netflix:     "https://www.netflix.com/browse",
  YouTube:     "https://www.youtube.com",
  AmazonPrime: "https://app.primevideo.com",
  DisneyPlus:  "https://www.disneyplus.com",
  Spotify:     "https://open.spotify.com",
} as const;

export const AndroidTV = {
  startPairing:  (host: string)    => native.startPairing(host),
  sendCode:      (code: string)    => native.sendCode(code),
  connect:       (host: string)    => native.connect(host),
  disconnect:    ()                => native.disconnect(),
  sendKey:       (keyCode: number) => native.sendKey(keyCode),
  sendAppLink:   (url: string)     => native.sendAppLink(url),
  forgetPairing: (host: string)    => native.forgetPairing(host),

  onSecret: (cb: () => void)                        => emitter.addListener("onSecret", cb),
  onReady:  (cb: () => void)                        => emitter.addListener("onReady", cb),
  onError:  (cb: (e: { message: string }) => void)  => emitter.addListener("onError", cb),
};
