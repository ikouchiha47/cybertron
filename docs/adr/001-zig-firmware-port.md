# ADR-001: Port firmware from Arduino/C++ to Zig

**Status:** Proposed  
**Date:** 2026-08-19  
**Deciders:** firmware team  
**Target:** RUNE-II or later

---

## Context

The current firmware is written in Arduino/C++ (`.ino` + header files) targeting the Seeed XIAO
nRF52840 Sense. It depends on three external libraries:

- **Adafruit Bluefruit** (nRF52 BSP) — C++ class hierarchy; `BLECharacteristic`, `BLEService`,
  `Bluefruit` singleton, callback registration via `setConnectCallback` / `setDisconnectCallback`
- **SparkFun BNO08x** — C++ wrapper over the `sh2` C API; internally calls `sh2_setSensorConfig`,
  `sh2_open`, etc. — the raw `sh2` API is already exposed in one call site in the firmware today
- **Arduino core** — `millis()`, `Serial`, `Wire`, `digitalRead`, GPIO abstractions (~40–60 call
  sites in the main sketch)

The codebase has grown to ~3800 lines across the main sketch and headers. Pain points:

- The Arduino IDE build model makes dependency management and reproducible builds difficult
- C++ template and header-only patterns make the gesture/logic layer hard to unit-test outside of
  hardware — the `IHardware` vtable interface was added specifically to work around this, but it
  still requires a stub that compiles against Arduino types
- No first-class cross-compilation story; flashing is IDE-driven
- `std::function` and vtable dispatch add overhead that is hard to measure or audit
- Undefined behavior in C++ is silent; bugs in timing-sensitive paths (BLE callbacks interacting
  with the SoftDevice task, ISR flag races) are difficult to reproduce and reason about

Zig addresses all of these: explicit allocators, no hidden control flow, `comptime` for zero-cost
generics, built-in cross-compilation, and a test runner that works on the host without hardware.

---

## Decision

Port the firmware to Zig in two layers. C libraries (`sh2.h`, nRF5 SDK softdevice BLE C API) are
called via Zig's `@cImport` — no Zig rewrites of hardware drivers. The Arduino build system is
replaced with `zig build` targeting `thumb-freestanding-eabi` (nRF52840 Cortex-M4).

### Layer 1 — Logic (pure Zig, host-testable)

No hardware calls. Ported first; tests run with `zig test` on any machine.

| Module | Current file | Zig notes |
|---|---|---|
| State packet serialization | `state_packet.h` | `packed struct` with explicit bit widths |
| Stillness detector | `StillnessDetector.h` | Pure state machine, no allocation |
| Gesture detector / axis detector | `gesture/` | Stateful, no I/O |
| Gesture arbitrator | `GestureArbitrator.h` | Pure logic |
| Event queue | `event_queue.h` | Ring buffer → `comptime`-generic `Queue(T, N)` |
| Fast math | `fast_math.h` | Trivial — Zig `@sqrt`, `@fabs` builtins |
| Shake detector | `shake_detector.h` | Pure |

Example — `state_packet.h` today defines a manually-packed byte layout. In Zig:

```zig
// src/state_packet.zig
pub const GestureId = enum(u8) {
    none        = 0,
    wrist_left  = 1,
    wrist_right = 2,
    arm_up      = 3,
    arm_down    = 4,
    shake       = 5,
};

pub const StatePacket = packed struct {
    gesture:    GestureId,  // 1 byte
    intensity:  u8,         // 1 byte
    flags:      u8,         // 1 byte — armed, raw_mode, etc.
    reserved:   u8 = 0,
    timestamp:  u32,        // 4 bytes, little-endian
};

comptime { std.debug.assert(@sizeOf(StatePacket) == 8); }

test "round-trip serialization" {
    const pkt = StatePacket{ .gesture = .wrist_left, .intensity = 200,
                              .flags = 0x01, .timestamp = 12345 };
    const bytes = std.mem.toBytes(pkt);
    const back  = std.mem.bytesToValue(StatePacket, &bytes);
    try std.testing.expectEqual(pkt.gesture, back.gesture);
    try std.testing.expectEqual(pkt.timestamp, back.timestamp);
}
```

The `comptime assert` on size fails at compile time if the layout drifts — something the C++ version
cannot do without a manual static_assert.

Example — `event_queue.h` is a fixed-capacity ring buffer templated on element type. In Zig:

```zig
// src/event_queue.zig
pub fn Queue(comptime T: type, comptime N: usize) type {
    return struct {
        buf:  [N]T = undefined,
        head: usize = 0,
        tail: usize = 0,
        len:  usize = 0,

        pub fn push(self: *@This(), item: T) bool {
            if (self.len == N) return false;
            self.buf[self.tail] = item;
            self.tail = (self.tail + 1) % N;
            self.len += 1;
            return true;
        }

        pub fn pop(self: *@This()) ?T {
            if (self.len == 0) return null;
            const item = self.buf[self.head];
            self.head = (self.head + 1) % N;
            self.len -= 1;
            return item;
        }
    };
}

// Usage — no heap, no allocator, no template instantiation overhead:
var gesture_queue = Queue(GestureId, 8){};
```

### Layer 2 — Hardware (Zig → C via `@cImport`)

#### BNO08x / sh2

The SparkFun C++ wrapper is discarded. The firmware already calls `sh2_setSensorConfig` directly;
Zig formalises this pattern for all IMU access.

```zig
// src/imu.zig
const sh2 = @cImport({
    @cInclude("sh2.h");
    @cInclude("sh2_SensorValue.h");
    @cInclude("sh2_err.h");
});

pub const Imu = struct {
    pub fn enableReport(sensor_id: sh2.sh2_SensorId_t, interval_us: u32) !void {
        var cfg = std.mem.zeroes(sh2.sh2_SensorConfig_t);
        cfg.reportInterval_us = interval_us;
        const rc = sh2.sh2_setSensorConfig(sensor_id, &cfg);
        if (rc != sh2.SH2_OK) return error.SensorConfigFailed;
    }

    // Called from the main poll loop — mirrors imu.getSensorEvent() + dispatch
    pub fn service(on_event: *const fn (val: *sh2.sh2_SensorValue_t) void) void {
        sh2.sh2_service();  // drains FIFO; fires the HAL callback registered in open()
        _ = on_event;       // callback is registered at open() time; stored in module state
    }
};

// HAL I2C callbacks — these are C functions Zig exports back to sh2_open()
// The actual I2C reads/writes call into nRF5 SDK TWI driver.
export fn sh2hal_open(pHal: [*c]sh2.sh2Hal_t) callconv(.C) c_int {
    pHal.*.open  = sh2hal_i2c_open;
    pHal.*.close = sh2hal_i2c_close;
    pHal.*.read  = sh2hal_i2c_read;
    pHal.*.write = sh2hal_i2c_write;
    pHal.*.getTimeUs = sh2hal_get_time_us;
    return sh2.SH2_OK;
}

// Sensor event callback — replaces imu.getSensorEventID() + switch dispatch
fn onSensorEvent(cookie: ?*anyopaque, p_event: [*c]sh2.sh2_SensorEvent_t) callconv(.C) void {
    _ = cookie;
    var value: sh2.sh2_SensorValue_t = undefined;
    _ = sh2.sh2_decodeSensorEvent(&value, p_event);
    switch (value.sensorId) {
        sh2.SH2_ROTATION_VECTOR => handleRotationVector(&value.un.rotationVector),
        sh2.SH2_GRAVITY         => handleGravity(&value.un.gravity),
        else                    => {},
    }
}
```

The I2C HAL (`sh2hal_i2c_open`, `_read`, `_write`) can be written as a thin C file
(`sh2_hal_i2c.c`) compiled alongside Zig, or implemented directly in Zig calling into the nRF5 SDK
TWI driver. The shim is the only hardware-specific code that cannot run on the host.

#### BLE (Adafruit Bluefruit → nRF5 SDK softdevice C API)

Bluefruit is a C++ wrapper over the nRF5 SDK softdevice BLE C API. The Zig port calls that C API
directly, which is what the nRF5 SDK headers expose.

```zig
// src/ble.zig
const sd = @cImport({
    @cInclude("ble.h");
    @cInclude("ble_gap.h");
    @cInclude("ble_gatt.h");
    @cInclude("ble_gatts.h");
    @cInclude("nrf_sdh.h");
    @cInclude("nrf_sdh_ble.h");
});

// UUIDs match what's in wristturn.ino exactly
const WRIST_SVC_UUID128 = [16]u8{
    0x14, 0x8A, 0x76, 0x68, 0x04, 0xD1, 0x6C, 0x4F,
    0x7E, 0x53, 0xF2, 0xE8, 0x00, 0x00, 0xB1, 0x19,
};

pub const Ble = struct {
    conn_handle:  u16 = sd.BLE_CONN_HANDLE_INVALID,
    gesture_hdl:  sd.ble_gatts_char_handles_t = undefined,
    state_hdl:    sd.ble_gatts_char_handles_t = undefined,

    pub fn init(self: *Ble) !void {
        var uuid128: sd.ble_uuid128_t = .{ .uuid128 = WRIST_SVC_UUID128 };
        var uuid_type: u8 = undefined;
        var rc = sd.sd_ble_uuid_vs_add(&uuid128, &uuid_type);
        if (rc != 0) return error.BleUuidAddFailed;

        var svc_uuid = sd.ble_uuid_t{ .uuid = 0x0000, .type = uuid_type };
        var svc_handle: u16 = undefined;
        rc = sd.sd_ble_gatts_service_add(sd.BLE_GATTS_SRVC_TYPE_PRIMARY, &svc_uuid, &svc_handle);
        if (rc != 0) return error.BleServiceAddFailed;

        try self.addGestureChar(svc_handle, uuid_type);
        try self.addStateChar(svc_handle, uuid_type);
    }

    fn addGestureChar(self: *Ble, svc_handle: u16, uuid_type: u8) !void {
        // Mirrors: gestureChar.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY)
        //          gestureChar.setFixedLen(GESTURE_CHAR_LEN)
        var char_md  = std.mem.zeroes(sd.ble_gatts_char_md_t);
        char_md.char_props.read   = 1;
        char_md.char_props.notify = 1;

        const uuid = sd.ble_uuid_t{ .uuid = 0x0001, .type = uuid_type };

        var attr_md = std.mem.zeroes(sd.ble_gatts_attr_md_t);
        sd.BLE_GAP_CONN_SEC_MODE_SET_OPEN(&attr_md.read_perm);

        var attr = std.mem.zeroes(sd.ble_gatts_attr_t);
        attr.p_uuid    = &uuid;
        attr.p_attr_md = &attr_md;
        attr.max_len   = GESTURE_CHAR_LEN;

        const rc = sd.sd_ble_gatts_characteristic_add(svc_handle, &char_md, &attr, &self.gesture_hdl);
        if (rc != 0) return error.BleCharAddFailed;
    }

    // Mirrors: gestureChar.notify(buf, len)
    pub fn notifyGesture(self: *Ble, data: []const u8) void {
        if (self.conn_handle == sd.BLE_CONN_HANDLE_INVALID) return;
        var hvx = sd.ble_gatts_hvx_params_t{
            .handle = self.gesture_hdl.value_handle,
            .type   = sd.BLE_GATT_HVX_NOTIFICATION,
            .p_data = data.ptr,
            .p_len  = &@as(u16, @intCast(data.len)),
            .offset = 0,
        };
        _ = sd.sd_ble_gatts_hvx(self.conn_handle, &hvx);
    }
};

// BLE event dispatch — replaces onConnect / onDisconnect callbacks registered via
// Bluefruit.Periph.setConnectCallback / setDisconnectCallback
pub fn handleBleEvent(p_ble_evt: [*c]sd.ble_evt_t, p_context: ?*anyopaque) callconv(.C) void {
    const ble = @as(*Ble, @ptrCast(@alignCast(p_context)));
    switch (p_ble_evt.*.header.evt_id) {
        sd.BLE_GAP_EVT_CONNECTED    => ble.conn_handle = p_ble_evt.*.evt.gap_evt.conn_handle,
        sd.BLE_GAP_EVT_DISCONNECTED => {
            ble.conn_handle = sd.BLE_CONN_HANDLE_INVALID;
            startAdvertising();
        },
        else => {},
    }
}
```

#### Advertising setup

```zig
// Mirrors: Bluefruit.setName("RUNE-I") + Bluefruit.Advertising.start(0)
fn startAdvertising() void {
    var adv_data = std.mem.zeroes(sd.ble_gap_adv_data_t);
    // ... fill adv_data with flags + local name "RUNE-I" ...

    var adv_params = sd.ble_gap_adv_params_t{
        .properties   = .{ .type = sd.BLE_GAP_ADV_TYPE_CONNECTABLE_SCANNABLE_UNDIRECTED },
        .interval     = 32,   // units of 0.625 ms — matches Bluefruit.Advertising.setInterval(32, 244)
        .duration     = 0,    // advertise indefinitely
        .filter_policy = sd.BLE_GAP_ADV_FP_ANY,
    };
    _ = sd.sd_ble_gap_adv_start(&adv_params, BLE_CONN_CFG_TAG);
}
```

### What is NOT ported

- The nRF5 SDK softdevice binary itself — it remains a prebuilt `.hex` flashed to the reserved
  memory region, exactly as today
- The I2C bus driver — one thin C file (`sh2_hal_i2c.c`) bridges sh2's HAL interface to the nRF5
  TWI driver; it is the only C file authored in this project going forward

---

## Alternatives considered

### Keep Arduino/C++, improve tooling

Use `arduino-cli` + CMake for reproducible builds; add a host-stub harness for unit tests.

**Rejected because:** does not eliminate UB, hidden allocations on hot paths, or the structural
coupling between logic and Arduino types. The cure adds complexity without removing the root problems.

### Rust (`no_std` + embassy)

Strong safety guarantees; `embassy` async runtime; `nrf-softdevice` crate for BLE.

**Rejected for now because:** the async executor adds conceptual overhead for what is fundamentally a
polling loop; C interop requires `bindgen` and a `build.rs` script; the borrow checker's learning
curve is steeper for contributors with a C background. Revisit at RUNE-III if the team grows.

### TinyGo

Go-like syntax, targets nRF52840.

**Rejected because:** GC pauses are unacceptable on a timing-sensitive BLE + IMU polling loop.

---

## Consequences

### Positive

- Logic layer is testable on the host with `zig test` — no device required, no stubs
- `comptime` size assertions on packed structs catch layout drift at compile time
- `zig build` gives a reproducible, single-command build; toolchain version pinned in `build.zig.zon`
- No undefined behavior by default; integer overflow traps in debug builds
- No C++ RTTI or exception tables; binary footprint expected to shrink
- Callback ownership is explicit — no global `Bluefruit` singleton with hidden registration state

### Negative / risks

- Zig is pre-1.0; API changes are possible — mitigated by pinning the toolchain version
- nRF5 SDK softdevice BLE C API is more verbose than Bluefruit's C++ abstraction; the setup code
  for characteristics and advertising is longer to write once but easier to audit
- `sh2_hal_i2c.c` shim must be written and validated on hardware before the IMU layer can be
  tested end-to-end — this is the first hardware gate in the implementation sequence
- Team needs Zig familiarity: ~1–2 weeks ramp for contributors with C background

### Neutral

- BLE protocol (UUIDs, packet format, characteristic layout) is unchanged — mobile app unaffected
- OTA update mechanism must be re-evaluated after the build system changes (tracked separately)

---

## Implementation order

1. Set up `zig build` targeting `thumb-freestanding-eabi` (nRF52840 Cortex-M4); confirm linker
   script produces a valid `.hex` alongside the softdevice
2. Port and test Layer 1 modules on the host (`zig test`) — no hardware required
3. Write `sh2_hal_i2c.c` shim; validate IMU sensor reports on hardware
4. Port BLE layer; validate gesture notifications end-to-end with the Android app
5. Port main loop (`setup()`/`loop()` → `pub fn main()`); retire `.ino` files
6. Remove SparkFun BNO08x C++ dependency from the build

The current Arduino firmware remains the production build until Step 6 is validated on hardware.
