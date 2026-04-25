Full set of problems the algorithm needs to solve, given these use cases:

1. Engagement — when is control active
  The hardest one. If pitch passively maps to brightness, every time you move your arm to scratch your head, brightness changes.
  All continuous control needs explicit engagement. Currently only knob has tap-to-engage.
  Pointer and slider need their own — but you can't use tap for everything simultaneously.

2. Reference anchoring — what is zero
  For "arm lifted = lights on" or "pitch = brightness slider" — lifted relative to what? Every user sits differently, stands differently, holds their arm differently.
  The baseline needs to be captured at engagement time, not factory-set. Otherwise the same arm position means different things per user per session.
  ZUPT is actually the anchor mechanism here — stationary moment on engagement = reference.

3. Axis isolation — roll bleeds into pitch
  When you pronate your wrist (roll), your elbow and shoulder compensate slightly — pitch and yaw both drift.
  For simultaneous independent controls (roll = volume, pitch = brightness), you need to know how much of the observed pitch change is incidental bleed from roll motion vs intentional.
  Without this, turning the volume accidentally moves the brightness slider.

  This is the kinematic coupling problem — joints don't move fully independently.

4. Output mapping — angle to value curve
  For volume: logarithmic maps better than linear — human hearing is logarithmic, small changes at low volume matter more.
  For brightness: probably linear or slight gamma.
  For "lights on at elevation X": threshold + hysteresis, not linear mapping at all.
  These are different functions. The algorithm needs to know which mapping applies, which is use-case dependent.

5. Tremor rejection without latency
  Raw pitch/yaw has hand tremor (3-8Hz). For a cursor or slider you need filtering — but too much filtering adds latency and makes the control feel laggy.
  This is a genuine tradeoff. Different use cases tolerate different latency: cursor needs <50ms, brightness slider can tolerate 100ms, "lights on" event can tolerate 200ms.

6. Threshold events vs continuous
  "Arm lifted = lights on" is categorically different from "pitch = brightness value":
  - Threshold event: one-shot trigger when crossing a level. Needs debounce. Does it latch (toggle) or sustain (lights stay on while arm is raised)?
  - Continuous: value tracks arm position in real time. Needs smooth mapping, tremor rejection.

  The algorithm needs to know which contract applies before it can emit anything sensible.

7. Fatigue
  Holding arm at a fixed elevation is tiring. Any scheme requiring sustained posture for sustained output (lights stay on while arm is raised) causes fatigue in 30-60 seconds. 
  Better design: threshold crossing fires a toggle, arm can return to rest. The algorithm needs to support both "held" and "latching" semantics.

  So the full problem set is:

  Snap/reposition detection    ← what we've been discussing
  Engagement / intent gate     ← when is control active
  Reference anchoring          ← what is neutral/zero
  Axis isolation               ← kinematic coupling between axes
  Output mapping               ← angle → value curve per use case
  Tremor rejection             ← noise filtering vs latency tradeoff
  Threshold vs continuous      ← event semantics vs value semantics
  Fatigue-aware design         ← don't require sustained postures
  Jerk and linear accel solve only the first one. The rest are separate problems, some algorithmic, some design decisions about what the interaction contract is.

The use case defines which subset of these you need to solve. "Lights on when lifted" needs: reference anchoring + threshold + debounce + latching. "Volume dial" needs: engagement + snap detection + output mapping + ZUPT re-baseline. "Brightness slider" needs all of them.
