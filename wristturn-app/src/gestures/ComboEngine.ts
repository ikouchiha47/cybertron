const COMBO_TIMEOUT_MS = 250;
const COMBO_MAX_LEN    = 3;

type ComboCallback = (combo: string) => void;

export class ComboEngine {
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onCombo: ComboCallback;
  // Prefixes that need buffering: "turn_right" if "turn_right,turn_right" is registered
  private prefixes = new Set<string>();

  constructor(onCombo: ComboCallback) {
    this.onCombo = onCombo;
  }

  /**
   * Call whenever the active mapping changes.
   * Extracts all multi-gesture combo prefixes so the engine knows
   * when to wait vs fire immediately.
   */
  setRegisteredCombos(combos: string[]): void {
    this.prefixes.clear();
    for (const combo of combos) {
      const parts = combo.split(",");
      if (parts.length < 2) continue;
      for (let i = 1; i < parts.length; i++) {
        this.prefixes.add(parts.slice(0, i).join(","));
      }
    }
  }

  push(gesture: string): void {
    const t = Date.now();
    if (this.buffer.length >= COMBO_MAX_LEN) this.flush();

    this.buffer.push(gesture);
    const current = this.buffer.join(",");

    if (this.timer) clearTimeout(this.timer);

    // No registered combo starts with this buffer — fire immediately
    if (!this.prefixes.has(current)) {
      console.log(`[ComboEngine] flush immediate t=${t} buffer=${current}`);
      this.flush();
      return;
    }

    // Wait in case the user adds another gesture to complete a combo
    console.log(`[ComboEngine] buffering t=${t} buffer=${current} waiting=${COMBO_TIMEOUT_MS}ms`);
    this.timer = setTimeout(() => {
      console.log(`[ComboEngine] timeout flush t=${Date.now()} buffer=${this.buffer.join(",")}`);
      this.flush();
    }, COMBO_TIMEOUT_MS);
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
