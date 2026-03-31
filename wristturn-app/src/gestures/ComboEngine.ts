const COMBO_TIMEOUT_MS = 800;
const COMBO_MAX_LEN    = 3;

type ComboCallback = (combo: string) => void;

export class ComboEngine {
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onCombo: ComboCallback;

  constructor(onCombo: ComboCallback) {
    this.onCombo = onCombo;
  }

  push(gesture: string): void {
    if (this.buffer.length >= COMBO_MAX_LEN) this.flush();

    this.buffer.push(gesture);

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), COMBO_TIMEOUT_MS);
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.buffer.length === 0) return;

    const combo = this.buffer.join(",");
    this.buffer = [];
    this.onCombo(combo);
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
