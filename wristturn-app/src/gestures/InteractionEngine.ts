// Axis pairing for snap-back suppression.
const OPPOSITE: Record<string, string> = {
  turn_right: "turn_left",  turn_left:  "turn_right",
  pitch_up:   "pitch_down", pitch_down: "pitch_up",
  yaw_right:  "yaw_left",   yaw_left:   "yaw_right",
};

// ── Rule types ────────────────────────────────────────────────────────────────

export type TerminalRule = {
  type: "terminal";
  token: string;
  action: string;
  refractoryMs?: number;  // default 200 — suppress identical token within window
  snapBackMs?: number;    // default 500 — suppress opposite-axis token after fire
  gobbleMs?: number;      // after fire, suppress all lower-priority rules for N ms
};

export type SequenceRule = {
  type: "sequence";
  tokens: string[];       // ordered token list, length >= 2
  windowMs: number;
  action: string;
};

export type RepeatRule = {
  type: "repeat";
  tokens: string[];       // entry sequence
  windowMs: number;
  action: string;
  intervalMs: number;
  cancelOn: string[];
};

export type InteractionRule = TerminalRule | SequenceRule | RepeatRule;

// ── Per-rule runtime state ────────────────────────────────────────────────────

type TerminalState = {
  lastFired: number;                              // timestamp of last fire
  axisLastFired: Record<string, { dir: string; time: number }>;
};

type SequenceState = {
  matched: number;        // index of next expected token
  deadline: number;       // timestamp by which next token must arrive (0 = no active match)
  // Tokens that were buffered during partial match but not yet forwarded.
  // When the window expires without completing, these fall through to lower-priority rules.
  pending: string[];
};

type RepeatState = {
  phase: "idle" | "partial" | "repeating";
  matched: number;
  deadline: number;
  lastFired: number;      // timestamp of last repeat fire
};

type RuleState = TerminalState | SequenceState | RepeatState;

// ── InteractionEngine ─────────────────────────────────────────────────────────

export class InteractionEngine {
  private rules: InteractionRule[] = [];
  private states: RuleState[] = [];
  private gobbleUntil = 0;   // set by the highest-priority rule that fired with gobbleMs
  private gobbleOwner = -1;  // rule index that set the gobble
  private onFire: (action: string) => void;
  private nowFn: () => number;

  constructor(onFire: (action: string) => void, nowFn: () => number = Date.now) {
    this.onFire = onFire;
    this.nowFn = nowFn;
  }

  setRules(rules: InteractionRule[]): void {
    this.rules = rules;
    this.states = rules.map((r) => this._makeState(r));
    this.gobbleUntil = 0;
    this.gobbleOwner = -1;
  }

  /**
   * Feed a gesture token into the engine.
   * now is optional; defaults to this.nowFn().
   */
  push(token: string, now: number = this.nowFn()): void {
    // Expire stale sequence windows first — this may flush pending tokens.
    this._expireSequences(token, now);

    // Check if any repeat rule is currently repeating and owns this token as cancel.
    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i];
      if (rule.type !== "repeat") continue;
      const st = this.states[i] as RepeatState;
      if (st.phase !== "repeating") continue;
      if (rule.cancelOn.includes(token)) {
        st.phase = "idle";
        st.matched = 0;
        st.deadline = 0;
        return; // consumed — do not forward
      }
    }

    // Evaluate rules in priority order.
    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i];

      // Gobble: if a higher-priority rule fired recently with gobbleMs, suppress
      // all rules with index > gobbleOwner.
      if (i > this.gobbleOwner && now < this.gobbleUntil) continue;

      if (rule.type === "terminal") {
        if (this._evalTerminal(i, rule, token, now)) return;
      } else if (rule.type === "sequence") {
        if (this._evalSequence(i, rule, token, now)) return;
      } else if (rule.type === "repeat") {
        if (this._evalRepeat(i, rule, token, now)) return;
      }
    }
  }

  /**
   * Call this periodically (or on each BLE event) to advance repeat timers.
   * Fires the repeat action when intervalMs has elapsed since last fire.
   */
  tick(now: number = this.nowFn()): void {
    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i];
      if (rule.type !== "repeat") continue;
      const st = this.states[i] as RepeatState;
      if (st.phase !== "repeating") continue;
      if (now - st.lastFired >= rule.intervalMs) {
        st.lastFired = now;
        this.onFire(rule.action);
      }
    }
  }

  reset(): void {
    this.states = this.rules.map((r) => this._makeState(r));
    this.gobbleUntil = 0;
    this.gobbleOwner = -1;
  }

  destroy(): void {
    this.rules = [];
    this.states = [];
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _makeState(rule: InteractionRule): RuleState {
    if (rule.type === "terminal") {
      return { lastFired: 0, axisLastFired: {} } as TerminalState;
    }
    if (rule.type === "sequence") {
      return { matched: 0, deadline: 0, pending: [] } as SequenceState;
    }
    return { phase: "idle", matched: 0, deadline: 0, lastFired: 0 } as RepeatState;
  }

  private _evalTerminal(idx: number, rule: TerminalRule, token: string, now: number): boolean {
    if (rule.token !== token) return false;

    const st = this.states[idx] as TerminalState;
    const refMs = rule.refractoryMs ?? 200;
    const snapMs = rule.snapBackMs ?? 0;

    // Refractory check.
    if (refMs > 0 && now - st.lastFired < refMs) return true; // suppressed but consumed

    // Snap-back check: if the opposite axis fired recently, suppress this token.
    const opposite = OPPOSITE[token];
    if (snapMs > 0 && opposite) {
      const axState = st.axisLastFired[opposite];
      if (axState && axState.dir === opposite && now - axState.time < snapMs) {
        return true; // suppressed
      }
    }

    // Fire.
    st.lastFired = now;
    if (snapMs > 0) {
      st.axisLastFired[token] = { dir: token, time: now };
      // Also update the opposite rule's axis state so snap-back works bidirectionally.
      // We walk the rule list to find the opposite terminal's state.
      for (let j = 0; j < this.rules.length; j++) {
        const r = this.rules[j];
        if (r.type === "terminal" && r.token === opposite) {
          const os = this.states[j] as TerminalState;
          os.axisLastFired[token] = { dir: token, time: now };
        }
      }
    }

    if (rule.gobbleMs && rule.gobbleMs > 0) {
      this.gobbleUntil = now + rule.gobbleMs;
      this.gobbleOwner = idx;
    }

    this.onFire(rule.action);
    return true;
  }

  private _evalSequence(idx: number, rule: SequenceRule, token: string, now: number): boolean {
    const st = this.states[idx] as SequenceState;
    const expected = rule.tokens[st.matched];

    if (token !== expected) {
      // Wrong token — if we had a partial match, reset it.
      if (st.matched > 0) {
        st.matched = 0;
        st.deadline = 0;
        st.pending = [];
      }
      return false;
    }

    // First token of sequence — start the window.
    if (st.matched === 0) {
      st.deadline = now + rule.windowMs;
      st.pending = [token];
    } else {
      // Subsequent token — check window hasn't expired.
      if (now > st.deadline) {
        // Expired — reset and don't claim this token.
        st.matched = 0;
        st.deadline = 0;
        st.pending = [];
        return false;
      }
      st.pending.push(token);
    }

    st.matched++;

    if (st.matched === rule.tokens.length) {
      // Complete match.
      st.matched = 0;
      st.deadline = 0;
      st.pending = [];
      this.onFire(rule.action);
      return true;
    }

    // Partial match — hold the token (don't forward to lower-priority rules).
    return true;
  }

  private _evalRepeat(idx: number, rule: RepeatRule, token: string, now: number): boolean {
    const st = this.states[idx] as RepeatState;
    const expected = rule.tokens[st.matched];

    if (token !== expected) {
      if (st.matched > 0) {
        st.phase = "idle";
        st.matched = 0;
        st.deadline = 0;
      }
      return false;
    }

    if (st.matched === 0) {
      st.deadline = now + rule.windowMs;
    } else if (now > st.deadline) {
      st.phase = "idle";
      st.matched = 0;
      st.deadline = 0;
      return false;
    }

    st.matched++;

    if (st.matched === rule.tokens.length) {
      st.phase = "repeating";
      st.matched = 0;
      st.deadline = 0;
      st.lastFired = now;
      this.onFire(rule.action);
      return true;
    }

    st.phase = "partial";
    return true;
  }

  /**
   * Expire any sequence windows that have timed out before processing a new token.
   * Pending tokens from expired sequences fall through to lower-priority rules.
   */
  private _expireSequences(_incomingToken: string, now: number): void {
    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i];
      if (rule.type !== "sequence") continue;
      const st = this.states[i] as SequenceState;
      if (st.matched === 0 || st.deadline === 0) continue;
      if (now <= st.deadline) continue;

      // Window expired — flush pending tokens to lower-priority rules.
      const pending = st.pending.slice();
      st.matched = 0;
      st.deadline = 0;
      st.pending = [];

      for (const t of pending) {
        // Push to rules below index i only.
        this._pushFrom(i + 1, t, now);
      }
    }
  }

  /**
   * Push a token starting from rule index `from` (used for fallthrough after sequence expire).
   */
  private _pushFrom(from: number, token: string, now: number): void {
    for (let i = from; i < this.rules.length; i++) {
      const rule = this.rules[i];
      if (i > this.gobbleOwner && now < this.gobbleUntil) continue;
      if (rule.type === "terminal") {
        if (this._evalTerminal(i, rule, token, now)) return;
      } else if (rule.type === "sequence") {
        if (this._evalSequence(i, rule, token, now)) return;
      } else if (rule.type === "repeat") {
        if (this._evalRepeat(i, rule, token, now)) return;
      }
    }
  }
}
