# InteractionEngine — Design & Implementation Plan

## Why this was built

The original gesture pipeline had three separate components doing overlapping jobs:

| Component | What it did | Problem |
|---|---|---|
| `GestureFilter` | shake gobble, snap-back cooldown, refractory | Global mutable state, not testable in isolation, no concept of priority |
| `ComboEngine` | sequence matching with timeout | Knew nothing about filtering — caller had to pre-filter before pushing |
| `HoldDetector` | 800ms time-based pitch hold | Ambiguous: can't distinguish "holding wrist still" from "stopped moving." Used raw IMU drift check as a proxy, which is fragile |

These three were wired together ad-hoc in `useBLE.ts` with mode-specific branching, side-channel callbacks, and ordering dependencies. Adding a new gesture type (e.g. triple-gesture hold) required touching all three files plus the wiring.

**Root cause of the hold ambiguity:** no EMG or continuous position signal. Time-based hold can't tell intent from stillness. The replacement: triple same gesture = deliberate hold intent. Unambiguous, consistent with how the rest of the gesture vocabulary works.

**Conceptual framing:** Unreal Engine's Enhanced Input System — rules as data, one interpreter. Instead of separate handler classes, each gesture behavior is a rule object evaluated by a single engine. Adding a new behavior = adding a rule, not a new class.

---

## Design

### One engine, three rule types

```
GestureToken (string)
      │
      ▼
┌─────────────────────────────┐
│      InteractionEngine      │
│                             │
│  Rules evaluated top-down   │
│  (static priority)          │
│                             │
│  ┌──────────┐               │
│  │ Terminal │  snap-back,   │
│  │          │  refractory,  │
│  │          │  gobble       │
│  └──────────┘               │
│  ┌──────────┐               │
│  │ Sequence │  prefix-hold, │
│  │          │  timeout      │
│  └──────────┘               │
│  ┌──────────┐               │
│  │  Repeat  │  entry seq,   │
│  │          │  interval,    │
│  │          │  cancel       │
│  └──────────┘               │
└─────────────────────────────┘
      │
      ▼
  onFire(action: string)
```

### Rule types

**Terminal** — single token → action. Carries per-token state (refractory, snap-back, gobble).

```typescript
{
  type: "terminal",
  token: "turn_right",
  action: "dpad_right",
  refractoryMs: 200,   // suppress duplicate within N ms
  snapBackMs: 500,     // suppress opposite-axis token within N ms after fire
  gobbleMs: 500,       // suppress all lower-priority rules for N ms after fire (shake uses this)
}
```

**Sequence** — N tokens in order within a time window → action. While a sequence is partially matched, its first token is held — not forwarded to lower-priority rules until the window expires.

```typescript
{
  type: "sequence",
  tokens: ["turn_right", "turn_right"],
  windowMs: 300,
  action: "ff",
}
```

**Repeat** — entry sequence → fire action → keep firing at interval → cancel on token. The cancel token is consumed silently (not forwarded to other rules).

```typescript
{
  type: "repeat",
  tokens: ["yaw_left", "yaw_left", "yaw_left"],
  windowMs: 600,
  action: "scroll_left",
  intervalMs: 200,
  cancelOn: ["yaw_right"],
}
```

### Priority model

Rules are ordered in the array — evaluated top to bottom, first match wins (static priority, like Express route ordering). A `Repeat` rule in `repeating` state has implicit priority: its `cancelOn` tokens are consumed before other rules see them.

`shake` always goes first in the rule array and uses `gobbleMs` to suppress lower-priority rules after firing.

### Hold = triple gesture

`HoldDetector` (time-based, 800ms) is deleted. Knob commit and symbol finalize use mode-scoped rule sets:

- GESTURE mode: own rule set from device mapping
- KNOB mode: `pitch_down,pitch_down,pitch_down` → `knob_commit`
- SYMBOL mode: `pitch_down,pitch_down,pitch_down` → `symbol_finalize`

`setRules()` is called on mode switch.

### Axis pairing for snap-back

```
turn_right ↔ turn_left   (roll axis)
pitch_up   ↔ pitch_down  (pitch axis)
yaw_right  ↔ yaw_left    (yaw axis)
```

snap-back suppresses the opposite token on the same axis after a terminal fires.

---

## Implementation checklist

### Step 1 — Tests
- [x] `src/gestures/__tests__/InteractionEngine.test.ts`
- [x] Confirmed tests fail before implementation

### Step 2 — Implement InteractionEngine
- [x] `src/gestures/InteractionEngine.ts`
  - [x] `InteractionRule` type union + exports
  - [x] `InteractionEngine` class
    - [x] `constructor(onFire, nowFn?)`
    - [x] `setRules(rules)`
    - [x] `push(token, now?)`
    - [x] `tick(now)` — advances repeat interval timers
    - [x] `reset()`
    - [x] `destroy()`
  - [x] Terminal state machine (refractory, snap-back, gobble)
  - [x] Sequence state machine (partial match, window timeout, fallthrough)
  - [x] Repeat state machine (entry, repeating, cancel)

### Step 3 — Add to test runner
- [x] `Makefile`: added `bun src/gestures/__tests__/InteractionEngine.test.ts` to `test` target

### Step 4 — Wire into useBLE.ts
- [x] Replace `ComboEngine`, `GestureFilter`, `HoldDetector` imports with `InteractionEngine`
- [x] Replace engine singleton construction
- [x] Replace `setActiveComboMap` — accepts full `ComboMap`, derives `InteractionRule[]`
- [x] Add mode-scoped rule sets (KNOB → triple-pitch commit, SYMBOL → triple-pitch finalize)
- [x] `setInterval(100ms)` ticks engine for repeat rules
- [x] Snap pre-filter inlined (constant `SNAP_PEAK_THRESHOLD = 4.5`)
- [x] `HoldDetector` replaced by `handlePitchDownForHold` (triple counter, 600ms window)

### Step 5 — Fix defaultMappings.ts
- [x] `ANDROIDTV_DEFAULT_MAPPING`: `yaw_left,yaw_left,yaw_left → back` (repeat rule)
- [x] Removed single `yaw_left` and `yaw_right` entries from TV mapping

### Step 6 — Delete dead code
- [x] Deleted `src/gestures/GestureFilter.ts`
- [x] Deleted `src/gestures/ComboEngine.ts`
- [x] Deleted `src/gestures/HoldDetector.ts`
- [x] Deleted `src/gestures/__tests__/GestureFilter.test.ts`

---

## Files touched summary

| File | Action |
|---|---|
| `src/gestures/InteractionEngine.ts` | **new** |
| `src/gestures/__tests__/InteractionEngine.test.ts` | **new** |
| `src/ble/useBLE.ts` | modified — replace 3 components with 1 engine |
| `src/devices/adapters/defaultMappings.ts` | modified — fix yaw mappings |
| `Makefile` | modified — add engine test to `test` target |
| `src/gestures/GestureFilter.ts` | **deleted** |
| `src/gestures/ComboEngine.ts` | **deleted** |
| `src/gestures/HoldDetector.ts` | **deleted** |
| `src/gestures/__tests__/GestureFilter.test.ts` | **deleted** |
