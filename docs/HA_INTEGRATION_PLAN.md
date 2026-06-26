# Home Assistant Integration — Plan

Status: proposed, not implemented.
Audience: r/homeassistant tinkerers and self-hosters. They are the validated
target tribe per market research (see notes at end). Path chosen accordingly:
RUNE must appear in HA as a **first-class device with auto-discovered entities**,
not as an opaque webhook source.

---

## Goal

Expose the wristband to Home Assistant such that:

1. RUNE appears in `Settings → Devices & Services → MQTT` as a single device
   named "RUNE" with multiple entities (gesture, arm pose, engagement, battery,
   connection state).
2. Users write automations using HA's standard event/state triggers — no custom
   YAML for our payload format, no copy-paste of magic strings.
3. Adding a new gesture in firmware/app surfaces in HA on next discovery
   publish without user intervention.
4. Works with stock HA + a Mosquitto broker (the default config for ~all
   tinkerers). No HA add-on, no custom integration code shipped to HA.

Non-goals (RUNE-I):
- No HA REST fallback. One protocol, done well.
- No matter/zigbee from device — see `CLAUDE.md` and the chip discussion in
  conversation log; RUNE-I stays BLE-via-phone.
- No HA companion-app integration (the phone-as-sensor flow). Different problem.

---

## Why MQTT Discovery (not REST events)

REST events would be ~50 LOC and work today. We are not doing that.

| Decision driver                   | REST events            | MQTT Discovery              |
|-----------------------------------|------------------------|-----------------------------|
| User-visible polish               | "fire event named X"   | Real device + entities      |
| Automation editor autocomplete    | None                   | Full event-type list        |
| Discoverability (UI tour)         | Hidden                 | Shows up under Devices      |
| Marketing surface (screenshot)    | Boring                 | This is the screenshot      |
| State entities (arm_pose, batt)   | Awkward (also events)  | Native sensors              |
| Multi-instance (two bands)        | Manual disambiguation  | Per-device discovery topics |
| Long-term cost of swap            | Have to redo all of it | None                        |

The "no hacks, do it right" constraint maps to MQTT Discovery. REST events
would be the hack we'd resent in three months.

---

## Allowlist decision required

`CLAUDE.md` gates new dependencies. This plan adds **one**:

- **`react-native-mqtt`** (or fork-of) — MQTT v3.1.1 client over TCP/TLS/WS

Justification:
- Implementing MQTT-over-TCP correctly with retained messages, QoS, keepalive,
  reconnect, LWT, TLS, and Will is non-trivial. Rolling our own is a project,
  not a feature.
- MQTT is the protocol the entire HA tinkerer ecosystem already uses. Shipping
  RUNE without an MQTT client is like shipping it without BLE.
- The library is small, single-purpose, and used in production by other RN
  apps. No transitive footprint surprise expected (verify before adding).

Alternative considered:
- **Hand-rolled MQTT over `react-native-tcp-socket`** (we already have it).
  Plausible, but every RUNE-I week spent on MQTT plumbing is a week not spent
  validating with users. Reject for RUNE-I, revisit for RUNE-II if maintenance
  burden of the dep proves real.

If a different MQTT lib is preferred (e.g., `paho-mqtt-react-native`, a
maintained fork), that's an open call to make at implementation start. The
abstraction in §Architecture isolates us from the choice.

---

## Architecture

Three layers, dependencies pointing inward, per `CLAUDE.md`:

```
UI (settings screen, status badges)
  ↓
Application (HaPublisher — orchestrates discovery + state publishing)
  ↓
Core (HaDiscovery — pure: builds discovery + state messages from a Device spec)
  ↓
Infrastructure (MqttTransport — wraps the chosen lib; substitutable)
```

Concretely:

### `wristturn-app/src/integrations/ha/`

| File                          | Layer          | Responsibility                                           |
|-------------------------------|----------------|----------------------------------------------------------|
| `HaDevice.ts`                 | core           | Device + entity spec types (no fetch, no MQTT, no React) |
| `HaDiscovery.ts`              | core           | Pure: builds `{ topic, payload, retain }` arrays         |
| `MqttTransport.ts`            | infra          | `interface MqttTransport` + concrete impl                |
| `HaPublisher.ts`              | application    | Subscribes to gesture/pose state, publishes via transport|
| `HaConfigStore.ts`            | infra          | Read/write broker URL, creds, device id (AsyncStorage)   |
| `useHaPublisher.ts`           | hook           | React glue: lifecycle, reconnect, status                 |

### Substitutability (Liskov)

`MqttTransport` is the seam:

```ts
export interface MqttTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  publish(topic: string, payload: string, opts: { retain: boolean }): Promise<void>;
  on(event: 'connect' | 'disconnect' | 'error', cb: (e?: Error) => void): void;
  isConnected(): boolean;
}
```

Two implementations from day one:
- `RealMqttTransport` — wraps `react-native-mqtt` (or chosen lib)
- `FakeMqttTransport` — records calls, used by tests, no network

Swapping the underlying MQTT lib later = one file change, no consumer impact.

### Why `HaDiscovery` is pure

Discovery payload format is a moving target (HA evolves it slowly but does
evolve it). Keeping it as a pure data transformation means:
- Tests are trivial: input Device spec → expected JSON
- We can dump the discovery messages to disk and `git diff` them when HA's
  schema changes

---

## Device & entity model

A single RUNE device exposes these entities, each derived from one source of
truth in our code:

| HA entity         | Component         | Source                       | Topic                              |
|-------------------|-------------------|------------------------------|------------------------------------|
| `event.gesture`   | `event` platform  | `MotionClassifier` output    | `rune/<id>/gesture`                |
| `sensor.arm_pose` | `sensor`          | firmware GravPose             | `rune/<id>/arm_pose`               |
| `binary_sensor.engaged` | `binary_sensor` | derived: pose != HANGING   | `rune/<id>/engaged`                |
| `sensor.battery`  | `sensor` (battery)| firmware (when available)    | `rune/<id>/battery`                |
| `binary_sensor.connected` | `binary_sensor` (connectivity) | BLE link state | `rune/<id>/connected` (LWT)        |

Discovery topic root: `homeassistant/<component>/rune_<id>/<entity>/config`.
Device id = first 6 hex of the BNO chip serial or BLE MAC, stable across
reconnects, distinct across multiple bands.

LWT (Last Will & Testament) on `rune/<id>/connected` = `offline` so the
connectivity sensor goes red automatically when the phone loses the broker
or the band loses BLE.

---

## Implementation order

Each step is independently deployable and validates the prior one. Tests come
first per `CLAUDE.md`.

### Step 1 — Core: `HaDiscovery` (pure, no deps)
- Define `HaDevice`, `HaEntity` types in `HaDevice.ts`.
- Implement `buildDiscoveryMessages(device)` and `buildStateMessage(entity, value)`.
- Tests: snapshot the discovery JSON for a fixture device. Assert topic format,
  retain flags, unique_id stability across calls.
- Failing tests confirmed → implement → tests pass. No app code touched.

### Step 2 — Infra: `MqttTransport` interface + Fake
- Write the interface.
- Implement `FakeMqttTransport` recording publishes in order.
- Test that `HaPublisher` (mocked) calls `connect → publish discovery (retained)
  → publish initial state` in that order.

### Step 3 — Application: `HaPublisher`
- Wires `MotionClassifier` events + arm pose state to the transport via
  `HaDiscovery`.
- Tests use `FakeMqttTransport` + RxJS marble tests for the event stream
  (allowed per `CLAUDE.md`).
- Verify:
  - On connect, all discovery messages publish first (retained).
  - On disconnect, no publishes attempted.
  - Reconnect re-publishes discovery (idempotent, retained, harmless).
  - Gesture events fire `event_type` payload.
  - Pose changes update `arm_pose` *and* `engaged` derived sensor.

### Step 4 — Infra: `RealMqttTransport`
- Add the chosen lib (allowlist decision pending — see above).
- Implement against real broker (Mosquitto in Docker).
- Integration test: spin up Mosquitto, publish, subscribe in test, assert.
- This is the only step that touches the dep; everything above is dep-free.

### Step 5 — UI: settings screen
- Form: broker host, port, TLS toggle, username, password, device name.
- "Test connection" button → `RealMqttTransport.connect()` with a 3 s timeout,
  then publish to `rune/test/<random>` and read it back via subscribe.
- "Forget broker" clears AsyncStorage and disconnects.
- Status badge in main UI: Connected / Disconnected / Error <message>.

### Step 6 — Hook into existing `useBLE`
- After the existing engagement gate, call `HaPublisher.onGesture(event, state)`.
- On pose change, call `HaPublisher.onPoseChange(prev, next)`.
- No conditional logic in `useBLE` — publisher is a no-op when not configured.

### Step 7 — Docs
- Update `docs/CHANGELOG.md`.
- Add `docs/HA_QUICKSTART.md` for end users (broker setup, settings screen
  walk-through, two example automations: "rotate_cw → bedroom dim", "arm_drop
  → lock everything").

---

## Test plan

Per `CLAUDE.md` test harness conventions: hand-rolled, named test, PASS/FAIL,
exit-non-zero on failure. RxJS marbles permitted for state machines.

**Unit (no network):**
- Discovery JSON snapshot matches expected schema.
- Topic format invariants (no spaces, no special chars in device id).
- Retain flag set on every discovery message, off on every state message.
- Derived `engaged` sensor flips correctly on pose transitions.
- Publisher idempotent: calling `republishDiscovery()` twice produces same
  topics with same payloads.

**Integration (Mosquitto in Docker):**
- Real broker round-trip: discovery → HA-shaped subscriber receives & parses.
- LWT fires on ungraceful disconnect.
- Reconnect after broker restart re-publishes discovery within 5 s.
- Authentication failure surfaces as a typed error, not a silent reconnect loop.

**Manual (human in HA UI):**
- Open `Settings → Devices & Services → MQTT` → RUNE device card present.
- Five entities visible, populated, and updating.
- Build an automation in the UI using the event entity — autocomplete shows
  every gesture name from the discovery payload.
- Disconnect band → connectivity sensor goes red within ~10 s.

---

## Edge cases & open questions

| Topic                                | Decision                                              |
|--------------------------------------|-------------------------------------------------------|
| Multiple RUNE bands per HA           | Each gets its own device id; discovery topics differ; |
|                                      | no global state shared.                               |
| Phone in background (iOS)            | MQTT will likely drop. LWT handles HA side. Reconnect |
|                                      | on app foreground. Document the limitation.           |
| Phone offline / broker unreachable   | Publisher buffers last N gestures? **Open.** Default: |
|                                      | drop and log to `DebugLog`. Real users may want       |
|                                      | buffer. Decide after first real-user feedback.        |
| Discovery payload format change      | Pure builder + snapshot tests catch the diff at CI.   |
| User wants HTTP REST instead of MQTT | Out of scope for RUNE-I. If demand surfaces, add a    |
|                                      | second `HaPublisher` impl behind the same interface.  |
| Engagement gate fires before HA      | Order: BLE parse → engagement gate → HA publish → app |
|                                      | mode routing. HANGING gestures never reach HA. Match  |
|                                      | the principle from `useBLE.ts` exactly.               |
| User configures bad credentials      | "Test connection" button must surface auth failure    |
|                                      | distinctly from network failure. No silent retry.     |
| TLS broker with self-signed cert     | Not RUNE-I. Stock Mosquitto + LAN is the validated    |
|                                      | use case; document this and revisit if asked.         |

---

## Validation criteria (so we know it's done)

1. Fresh HA install + Mosquitto + RUNE app → device appears in HA within 30 s
   of opening the settings screen.
2. Three example automations from `HA_QUICKSTART.md` work end-to-end on first
   try, no edits beyond entity_id substitution.
3. All `Test plan` items pass; CI gates on the unit + integration suites.
4. One r/homeassistant post with a 30 s demo gets ≥10 substantive comments
   (not just upvotes). This is the actual product validation, not a CI gate,
   but it's the reason we're building it this way.

---

## Why this plan exists

Earlier conversation surfaced that RUNE's most plausible early audience is
HA tinkerers, not Harmony refugees and not generic smart-home consumers. That
audience does not want a webhook. They want a device that behaves like every
other device in their HA setup. The "do it right the first time" constraint
combined with the audience research is what selects MQTT Discovery over REST.

The pure core / substitutable transport / single-dep choice keeps the door
open to swap the MQTT lib (or, much later, add a Matter-direct path) without
rewriting the publisher or touching `useBLE.ts`.
