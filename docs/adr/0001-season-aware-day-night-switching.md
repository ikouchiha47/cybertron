# ADR 0001 — Season-aware day/night camera switching (solar boundary + luminance override)

- **Status:** Proposed
- **Date:** 2026-10-10
- **Deciders:** DoorCam maintainer
- **Replaces:** hardcoded 07:00/19:00 boundary in `activeProfileSlot`

---

## Context

DoorCam switches each `auto` camera between a **day profile** and a **night
profile**. The night profile pins the sensor (`exposureLock:true` → `aec=0`,
`agc=0`, `aecValue:750`, `agcGain:15`); the day profile leaves auto-exposure
(AEC/AGC) unlocked.

Today the boundary is a **hardcoded wall-clock window**: day = 07:00–18:59,
night = 19:00–06:59 local. It is defined in `activeProfileSlot`
(`src/utils/cameraConfig.ts:243`), re-hardcoded for the in-session timer in
`msUntilNextBoundary` (`src/hooks/useDayNightSwitch.ts:32-44`), and duplicated a
third time in `CameraSettingsSheet.tsx:37`.

### Problem

The clock boundary does not track when it is actually dark. In winter, civil
dusk arrives around **18:00–18:30**, i.e. up to an hour before the 19:00 switch.
During that gap a camera runs the **day profile with free-running AEC**.

Observed on device (2026-10-10, ~18:43 local, camera `192.168.0.126`): the frame
oscillates every 1–4 s between a dark, grainy frame (meanLuma ≈ 88) and a fully
blown white/pink frame (meanLuma ≈ 238, up to 11 % of pixels ≥ 240) for the whole
capture window. This is the OV2640 auto-exposure hunting at low light and
crossing the sensor's exposure cliff — the same blow-out documented in the v4→v5
`fixNightExposure` migration (`src/utils/migrations.ts:246-274`). The night
profile stops it because it locks exposure, but only at 19:00.

So the defect is the **fixed-time boundary mismatched against real dusk**, not the
profiles themselves.

### Constraints

- The camera control plane is pure JS `fetch` to `http://<ip>/control`
  (`src/utils/cameraSettings.ts:54`), so the day/night decision can stay in JS.
- The native pipeline already computes a per-frame `meanLuma`
  (`MotionGate.kt:60,116-122`) but **never surfaces it** to JS
  (`InferencePipeline.kt:397-411` reads only `gate.motion`).
- `Camera`/`CameraStore` have no location field, and the app has no location
  permission or package today (`app.json`, `AndroidManifest.xml`).

---

## Decision

Adopt a **hybrid** auto day/night policy:

1. **Solar boundary (authority for both directions).** Compute local **`dusk`**
   (civil twilight ends) and **`dawn`** (civil twilight begins) on-device with
   `suncalc` and compare **absolute instants**. Day = between dawn and dusk;
   night otherwise.
2. **Luminance override (day → night only).** Use the camera's own frame
   brightness to switch to night *earlier* than dusk (overcast, storm, deep
   shade), never to switch back to day.

Night → day is **always** returned by the solar `dawn` instant, never by raw
luminance (see rationale below).

### Library

`suncalc@^2.1.1` (maintained, released 2026-10-05; pure JS, zero-dependency,
Metro-safe, **ships its own TS types**). Use `getTimes(date, lat, lng)`, then
`dusk`/`dawn` — not `sunset`/`sunrise`, which are the wrong phase for a "is it
dark yet" test.

- Results are absolute UTC `Date` instants → compare with `getTime()`; timezone
  and DST become non-issues.
- Do **not** add `@types/suncalc` (still pinned to v1 semantics and will conflict).

### Location

Store `lat`/`lng` once on the store (a doorcam is fixed). **GPS is primary**:
read it via `expo-location` (`getForegroundPermissionsAsync` →
`requestForegroundPermissionsAsync` only when not granted →
`getLastKnownPositionAsync` first, then `getCurrentPositionAsync` with a
timeout). **Manual override** for "behave as if in region X": a searchable
worldwide country list (static, capital coordinates, no map dependency) plus
editable lat/lng fields for fine-tuning. GPS only ever *fills* the stored value,
so a denied permission never breaks switching. Longitude precision is negligible
(≈4 s of sunset error per 0.01°). With **no coordinates, fall back to the
existing 07:00/19:00 rule** so the feature degrades gracefully.

Rejected: `react-native-maps` for the override (map tile key + native config for
a rarely-changed setting).

### Degenerate cases

- Missing field → fallback ladder `dusk → sunset → nauticalDusk`, `dawn → sunrise
  → nauticalDawn`; guard both `null` and `Invalid Date`.
- Polar: `alwaysUp` → force day; `alwaysDown` → force night.
- Cap the scheduling timeout and re-verify on `AppState === 'active'` (the
  existing `recheck` path) so clock/DST jumps self-correct.

### Why luminance must not drive night → day

The night profile locks exposure and (potentially) the IR illuminator/`raw_gma`
gamma changes what the sensor sees. A single brightness metric would read
"bright enough = day" the instant night engaged → oscillation. Shipping products
avoid this by using **different signals per direction** (luminance to go dark, a
chroma/IR-insensitive or scheduled signal to return to light). DoorCam uses
luminance **only** to advance the night switch and lets `dawn` own the return.

---

## Consequences

### Positive

- Whitening/blow-out window disappears in winter (and any season).
- Self-adjusting year-round; no manual seasonal edit.
- Luminance override catches early darkness (clouds/storms) that the clock and
  the sun both miss.
- Decision logic stays in pure, unit-testable TS (`cameraConfig` + a new
  `sunWindow` helper); the clock-based timer generalises to "next real boundary".

### Negative / costs

- New dependency (`suncalc`) and, if using GPS, `expo-location` + a location
  permission and a native rebuild.
- Store migration to add `lat`/`lng`.
- Phase 2 requires a **native change + rebuild** (exposing `meanLuma` through the
  existing `getMetrics()` poll).
- New tuning surface (luma threshold, dwell, lockout) that must be calibrated.

### Neutral

- The manual `day` / `night` overrides remain, bypassing all auto logic.
- No change to the camera control path (`cameraSettings.ts`) — it already accepts
  a resolved `CameraSettings`.

---

## Alternatives considered

| Option | Verdict |
|---|---|
| **Keep fixed clock**, just make start/end configurable | Rejected as the primary: still manual per season; doesn't react to weather. Kept as the **no-coords fallback**. |
| **Sunset only** (no luminance) | Simpler, deterministic, but misses early darkness (overcast). Kept as Phase 1 and the base policy. |
| **Luminance only** (no solar) | Rejected: feedback with locked exposure/IR and no reliable night→day signal → flapping. |
| **Cap AEC in the day profile** (mitigation only) | Rejected as the fix: masks the symptom but leaves the profile wrong; could be added later as belt-and-braces. |
| **Offline IP/geo geocoding** | Rejected: needs network, less precise, and the camera is fixed. |

---

## References

- Code: `src/utils/cameraConfig.ts:240-249`, `src/hooks/useDayNightSwitch.ts`,
  `src/components/CameraSettingsSheet.tsx:33-38`, `src/utils/migrations.ts:246-274`,
  `android/.../MotionGate.kt:60,116-122`, `android/.../InferencePipeline.kt:397-411,509-561,665-712`,
  `src/hooks/useEngineMetrics.ts`, `src/utils/cameraSettings.ts:54-165`.
- Device evidence: 60 s capture 2026-10-10 18:43 local, camera `192.168.0.126`,
  meanLuma oscillating 88 ↔ 238. See `docs/plans/day-night-switching-tasks.md`.
- `suncalc` v2.1.1 — https://github.com/mourner/suncalc
- Expo Location (SDK 54) — https://docs.expo.dev/versions/v54.0.0/sdk/location/
- Day/night hysteresis prior art: Vicon IQeye, Tuya IPC, FLIR, Petra thesis
  (separate day→night / night→day thresholds + dwell + post-switch lockout).
