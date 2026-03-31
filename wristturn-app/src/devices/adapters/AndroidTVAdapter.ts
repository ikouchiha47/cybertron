import { AndroidTV, KeyCode, AppLink } from "../../../modules/androidtv";
import type { IDeviceAdapter } from "./IDeviceAdapter";
import type { Command, DeviceMetadata } from "../../types";

export const ANDROIDTV_COMMANDS: Command[] = [
  { id: "dpad_right",      label: "Right",          payload: KeyCode.DPAD_RIGHT },
  { id: "dpad_left",       label: "Left",            payload: KeyCode.DPAD_LEFT },
  { id: "dpad_up",         label: "Up",              payload: KeyCode.DPAD_UP },
  { id: "dpad_down",       label: "Down",            payload: KeyCode.DPAD_DOWN },
  { id: "dpad_center",     label: "Select",          payload: KeyCode.DPAD_CENTER },
  { id: "back",            label: "Back",            payload: KeyCode.BACK },
  { id: "home",            label: "Home",            payload: KeyCode.HOME },
  { id: "volume_up",       label: "Volume Up",       payload: KeyCode.VOLUME_UP },
  { id: "volume_down",     label: "Volume Down",     payload: KeyCode.VOLUME_DOWN },
  { id: "mute",            label: "Mute",            payload: KeyCode.MUTE },
  { id: "play_pause",      label: "Play / Pause",    payload: KeyCode.MEDIA_PLAY_PAUSE },
  { id: "media_next",      label: "Next",            payload: KeyCode.MEDIA_NEXT },
  { id: "media_prev",      label: "Previous",        payload: KeyCode.MEDIA_PREV },
  { id: "ff",              label: "Fast Forward",    payload: KeyCode.MEDIA_FF },
  { id: "rewind",          label: "Rewind",          payload: KeyCode.MEDIA_REWIND },
  // App launches via deep link
  { id: "open_netflix",    label: "Open Netflix",    payload: { link: AppLink.Netflix } },
  { id: "open_youtube",    label: "Open YouTube",    payload: { link: AppLink.YouTube } },
  { id: "open_prime",      label: "Open Prime",      payload: { link: AppLink.AmazonPrime } },
  { id: "open_disney",     label: "Open Disney+",    payload: { link: AppLink.DisneyPlus } },
  { id: "open_spotify",    label: "Open Spotify",    payload: { link: AppLink.Spotify } },
];

export class AndroidTVAdapter implements IDeviceAdapter {
  readonly meta: DeviceMetadata;
  private _connected = false;

  constructor(meta: DeviceMetadata) {
    this.meta = meta;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let done = false;
      const timeout = setTimeout(() => {
        if (done) return;
        done = true;
        readySub.remove();
        errSub.remove();
        reject(new Error("TV connect timeout"));
      }, 8000);

      const readySub = AndroidTV.onReady(() => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        readySub.remove();
        errSub.remove();
        this._connected = true;
        resolve();
      });
      const errSub = AndroidTV.onError((e) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        readySub.remove();
        errSub.remove();
        reject(new Error(e.message));
      });
      AndroidTV.connect(this.meta.host).catch((e: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        readySub.remove();
        errSub.remove();
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  async disconnect(): Promise<void> {
    await AndroidTV.disconnect();
    this._connected = false;
  }

  async sendCommand(command: Command): Promise<void> {
    const payload = command.payload;

    // App deep link
    if (payload && typeof payload === "object" && "link" in (payload as object)) {
      await AndroidTV.sendAppLink((payload as { link: string }).link);
      return;
    }

    // Keycode
    if (typeof payload === "number") {
      await AndroidTV.sendKey(payload);
    }
  }

  isConnected(): boolean {
    return this._connected;
  }
}
