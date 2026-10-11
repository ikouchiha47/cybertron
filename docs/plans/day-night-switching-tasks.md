# Plan — Season-aware day/night switching

Implements **ADR 0001**. Two phases. Phase 1 is JS/TS-only and self-contained;
Phase 2 adds a small native change and needs a rebuild.

Related: `docs/adr/0001-season-aware-day-night-switching.md`

**Definition of done (both phases):** on a winter evening, an `auto` camera goes
to the night profile at real dusk (not 19:00) and the frame never blows out white.
Primary evidence: device capture (`doorcam-device-harness`) showing the profile
switch at the computed dusk and no AEC oscillation in the preceding hour; plus
`vitest` green.

---

## Phase 1 — Solar boundary (JS/TS only, no rebuild)

> Outcome: night starts at real dusk/dawn from coordinates. No coords → unchanged
> 07:00/19:00 behaviour.

### 1.1 Dependency

- [ ] `npm install suncalc@^2.1.1` (add to `package.json` dependencies).
- [ ] Do **not** install `@types/suncalc` (v1-only, conflicts with suncalc v2's
      bundled types).
- [ ] Sanity: `node -e "const s=require('suncalc');console.log(s.getTimes(new Date(),51.5,-0.12).dusk)"`.

### 1.2 Config model

- [ ] Add `location?: { lat: number; lng: number }` to `CameraStore`
      (`src/utils/cameraConfig.ts:185-197`), or to the detection settings block if
      you prefer it scoped to detection. Document the field.
- [ ] Bump `CURRENT_VERSION` in `src/utils/migrations.ts` and add a migration that
      leaves `location` absent (so no-coords keeps old behaviour). Coordinate with
      `storage.ts` (`detectRawVersion`/`migrateStore`, key `doorcam_config`).
- [ ] Add a `sunWindow` config block (Phase 2 tuning lives here from the start):
      `{ enabled, lumThreshold?, dwellMs?, lockoutMs? }` — defaults documented.

### 1.3 New pure helper — `src/utils/sunWindow.ts`

- [ ] `resolveNightWindow(now: Date, lat: number, lng: number): NightWindow`
      returning `{ dusk: Date | null; dawn: Date | null; alwaysUp: boolean; alwaysDown: boolean }`.
- [ ] Fallback ladders: night anchor `dusk → sunset → nauticalDusk`; day anchor
      `dawn → sunrise → nauticalDawn`.
- [ ] `isNight(now, window)` comparing **instants** (`getTime()`), not hours.
- [ ] `msUntilNextBoundary(now, window)` — next dusk or dawn instant, **capped**
      (e.g. ≤ 6 h) and recomputed from today's **and tomorrow's** events.
- [ ] `valid(d)` guard for `null | undefined | Invalid Date`.
- [ ] Handle polar: `alwaysUp` → day, `alwaysDown` → night.

### 1.4 Wire the boundary through existing code

- [ ] Refactor `activeProfileSlot(camera, hour: number)` →
      `activeProfileSlot(camera, now: Date, window: NightWindow | null)`
      (`src/utils/cameraConfig.ts:240-244`). `null` window = the 07:00/19:00
      fallback (preserve exact old semantics).
- [ ] `resolveProfile` signature update to match (`cameraConfig.ts:247-249`).
- [ ] Replace `msUntilNextBoundary` in `src/hooks/useDayNightSwitch.ts:32-44` with
      the `sunWindow` version; keep the single-shot `appliedRef` logic and the
      `recheck`-on-foreground path (`App.tsx:142-155`).
- [ ] Remove the duplicated `hour >= 7 && hour < 19` in
      `src/components/CameraSettingsSheet.tsx:33-38`; call the shared helper.
- [ ] Update `App.tsx:406-414` (`handleSetDayNightMode`) and
      `src/utils/cameraSettings.ts:245-275` (slot-aware `/status` adoption) to the
      new signature — they use `currentLocalHour()`.

### 1.5 Location & Settings UI

Location is stored once as `lat`/`lng`; two ways to set it, GPS first.

**GPS primary**
- [ ] `npm install expo-location`; add plugin to `app.json` with
      `locationWhenInUsePermission`; rebuild native.
- [ ] On first setup (and via a "Refresh location" action), read location:
      `getForegroundPermissionsAsync` → request only if not granted →
      `getLastKnownPositionAsync` first, then `getCurrentPositionAsync({ accuracy:
      Balanced })` behind a ~12 s timeout. Write the result into the stored
      `lat`/`lng`.
- [ ] GPS is a convenience, never required: if permission is denied or it times
      out, keep the existing/ manual value and continue.

**Manual region override**
- [ ] Searchable **worldwide country list** (`src/data/countries.ts`, static,
      capital-based coordinates) that sets `lat`/`lng` when a country is picked —
      for "behave as if in region X". No map dependency.
- [ ] Editable numeric **Latitude / Longitude** fields (validation) for
      fine-tuning (country-level points are coarse for large countries).
- [ ] Read-only readout of **"tonight's dusk / tomorrow's dawn"** for sanity.
- [ ] Decided against `react-native-maps` (needs Google API key + native config)
      for this rarely-changed override.

### 1.6 Tests

- [ ] Extend `src/utils/cameraConfig.test.ts`: update the existing hour-based cases
      to the new signature; keep equivalent fallback assertions.
- [ ] Add `src/utils/sunWindow.test.ts` with **pinned** `suncalc` values for a fixed
      `lat/lng/date` (a mid-latitude winter date and a summer date), plus
      `alwaysUp`/`alwaysDown` and null-fallback cases.
- [ ] `npm test` green.

### 1.7 Phase 1 verification

- [ ] Set coords near the install; confirm the computed dusk is ~18:1x–18:3x in
      winter (sanity vs a weather source).
- [ ] Device: force the clock near dusk (or wait), confirm the profile pushes at the
      computed instant (logcat `[DoorCam] day/night switch`), and the camera settles
      instead of blowing out.

---

## Phase 2 — Luminance override (native + JS, needs rebuild)

> Outcome: overcast/early darkness pulls night **before** dusk. `dawn` still owns
> the return to day. No flapping.

### 2.1 Native — expose `meanLuma`

- [ ] `InferencePipeline.kt`: stash the last `gate.meanLuma` per camera where the
      gate result is read (`:397-411`; `MotionGate.Result` already carries it).
- [ ] Include `meanLuma` in the `getMetrics()` payload (`InferencePipeline.kt:665-712`).
- [ ] Confirm `DoorCamModule.getMetrics` merges it into the per-camera object the
      same way it merges `drawn` (`DoorCamModule.kt:41`).
- [ ] `./gradlew assembleRelease` + install.

### 2.2 JS — consume + decide

- [ ] `src/hooks/useEngineMetrics.ts`: add `meanLuma` to `NativeCameraMetrics`
      (`:39-53`) and `CameraEngineStat` (`:7-30`) via `num(...)` (`:67-69`).
- [ ] New `src/hooks/useLuminanceNightOverride.ts` (or fold into
      `useDayNightSwitch`): EMA `0.3·luma + 0.7·prev`; **day→night only** when the
      EMA stays below threshold for `dwellMs`; **no** luma-driven night→day.
- [ ] Thresholds: base on the native scale (`MotionGate.NIGHT_LUMA = 55`) with the
      configured `lumThreshold`; keep default conservative.
- [ ] Enforce `lockoutMs` after any switch before allowing the opposite check.
- [ ] Combine with the solar slot in `App.tsx`: `auto` → `night` if
      `solarNight || lumaNight`; day only when solar `dawn` (and luma clear).

### 2.3 Phase 2 verification

- [ ] Rebuild + install, then run `doorcam-device-harness` capture across dusk:
      confirm meanLuma **rises then stays stable** (no 88↔238 oscillation) and the
      profile switched before/at dusk.
- [ ] Force a night→day flap attempt (e.g. shine a light): confirm the override
      does **not** return to day while it is still before `dawn`.
- [ ] `npm test` still green (any threshold/EMA logic factored as pure functions).

---

## Rollout / safety

- [ ] Ship with `sunWindow.enabled` respected; `auto` with no coords = today's
      behaviour, so the change is inert until coords are set.
- [ ] Settings exposes the effective boundary so a bad clock/coords is visible.
- [ ] Interim manual escape hatch documented: set a camera to `night` mode to pin
      exposure immediately (kills the AEC hunt tonight).

## Evidence log

- 2026-10-10 18:43 local — 60 s device capture, camera `192.168.0.126`:
  meanLuma oscillated 88 ↔ 238 (day profile, pre-19:00), confirming the defect.
- Device access: `adb connect 192.168.0.154:42093` (wireless debugging).
