#pragma once
#include <stdint.h>
#include <stddef.h>

// ── SPSC Event Queue ──────────────────────────────────────────────────────────
//
// Single-Producer Single-Consumer lock-free ring buffer for deferred firmware
// events. Replaces individual volatile bool flags with a single typed queue.
//
// PROBLEM WITH VOLATILE BOOLS
// ───────────────────────────
// The current pattern:
//
//   static volatile bool pendingEnableReports = false;  // set in BLE callback
//   static volatile bool pendingExitSleep     = false;  // set in IMU handler
//
// Has two hidden assumptions:
//   1. Events of the same type are idempotent — if the BLE callback fires twice
//      before loop() runs, the second write is silently dropped. For these two
//      specific flags that's harmless, but it's an accident of the design.
//   2. Each new deferred action needs a new volatile bool. The pattern doesn't
//      scale; it leaks into the global namespace and has no backpressure.
//
// THE SPSC RING BUFFER
// ────────────────────
// A ring buffer with one writer (producer) and one reader (consumer) can be
// made lock-free with only two shared variables: head (written by producer,
// read by consumer) and tail (written by consumer, read by producer).
//
// Because writes to head and tail are done by exactly one side each, no mutex
// is needed. The only requirement is that the CPU and compiler do not reorder
// the payload write relative to the head update. On ARM Cortex-M4 (nRF52840),
// a Data Memory Barrier (__DMB()) between the two enforces this.
//
// TOPOLOGY IN THIS FIRMWARE
// ─────────────────────────
//   Producer: BLE callbacks + IMU event handlers
//             (run in SoftDevice / getSensorEvent() interrupt context)
//   Consumer: loop()
//             (runs in main/thread context, lower priority than SoftDevice)
//
// This is exactly SPSC — only one context produces, only one consumes.
// No other topology (MPSC, MPMC) is needed here.
//
// MEMORY ORDERING ON CORTEX-M4
// ─────────────────────────────
// ARM Cortex-M4 is weakly ordered for device memory but strongly ordered for
// normal memory (write-buffer aside). The nRF52840's SRAM is normal memory,
// so stores are observed in program order by other Cortex-M4 observers.
// However the C/C++ compiler may reorder across sequence points.
//
// We use volatile on head/tail to prevent compiler reordering, and __DMB()
// as a compiler + hardware barrier between payload write and head update.
//
// If porting to an architecture with a weaker memory model (e.g. Cortex-A),
// replace __DMB() with std::atomic and memory_order_acquire/release on the
// head/tail variables.
//
// CAPACITY AND DROP POLICY
// ────────────────────────
// QUEUE_CAPACITY must be a power of two so modulo wraps with a bitmask.
// When the queue is full, push() drops the incoming event and returns false.
// The caller can log a warning. Events are cheap (one byte each), so
// QUEUE_CAPACITY=8 is more than enough for this firmware's event rate.
//
// USAGE
// ─────
//   // Declaration (one per firmware, file scope):
//   static EventQueue<8> events;
//
//   // Producer side (BLE callback / IMU handler):
//   events.push(EVT_ENABLE_REPORTS);
//
//   // Consumer side (loop()):
//   uint8_t evt;
//   while (events.pop(evt)) {
//     switch (evt) {
//       case EVT_ENABLE_REPORTS: enableReports(); break;
//       case EVT_EXIT_SLEEP:     exitSleep();     break;
//     }
//   }
//
// EVENT CODES
// ───────────
// Define as an enum or constexpr uint8_t. Keep them < 256.

static constexpr uint8_t EVT_ENABLE_REPORTS = 1;
static constexpr uint8_t EVT_EXIT_SLEEP     = 2;
// Add new events here. No new volatile globals needed.

// ── Implementation ────────────────────────────────────────────────────────────

template<size_t N>
class EventQueue {
    static_assert((N & (N - 1)) == 0, "N must be a power of two");
    static constexpr size_t MASK = N - 1;

    uint8_t          _buf[N];
    volatile size_t  _head = 0;  // producer writes, consumer reads
    volatile size_t  _tail = 0;  // consumer writes, producer reads

public:
    // Push from producer context (BLE callback / ISR).
    // Returns false and drops the event if the queue is full.
    bool push(uint8_t evt) {
        size_t head = _head;
        size_t next = (head + 1) & MASK;
        if (next == _tail) return false;  // full — drop

        _buf[head] = evt;
        __DMB();          // ensure payload is visible before head advances
        _head = next;
        return true;
    }

    // Pop from consumer context (loop()).
    // Returns false if the queue is empty.
    bool pop(uint8_t& evt) {
        size_t tail = _tail;
        if (tail == _head) return false;  // empty

        evt = _buf[tail];
        __DMB();          // ensure payload is read before tail advances
        _tail = (tail + 1) & MASK;
        return true;
    }

    bool empty() const { return _head == _tail; }
};
