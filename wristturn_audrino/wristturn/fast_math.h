#pragma once

// fast_math.h — pluggable 3-axis vector normalisation.
//
// Pick an implementation at compile time:
//
//   (default)               → RUNE_NORMALISE_NAIVE
//                             1 sqrtf + 3 divisions. Bit-identical to a
//                             hand-written `x/sqrt(...)`. Safe baseline.
//
//   -DRUNE_NORMALISE_FAST   → Quake-style bit-hack inverse sqrt + 1 Newton
//                             iteration + 3 multiplications. Approximate
//                             (~1.7e-3 max error). Use when the consumer
//                             threshold has headroom — e.g. arm-pose
//                             classifier at 0.75 with no interest in
//                             three-decimal precision. On Cortex-M4
//                             (FPV4-SP, no rsqrt instruction) saves ~40+
//                             cycles per call vs naive (VDIV is ~14 cycles).
//
// The dispatcher sits behind a single `normalise3()` call — switch the
// implementation by changing one #define at the build entry point, not by
// hunting through call sites.
//
// To benchmark the same implementation that ships on device, include this
// header in tmp/bench_invsqrt.c and call `normalise3()` instead of the
// per-variant functions there.

#include <math.h>
#include <stdint.h>

// ── Implementations ──────────────────────────────────────────────────────────

static inline void rune_normalise3_naive(float x, float y, float z,
                                          float* xn, float* yn, float* zn) {
  float mag = sqrtf(x * x + y * y + z * z);
  *xn = x / mag;
  *yn = y / mag;
  *zn = z / mag;
}

// Quake III rsqrt — Carmack/Beyond3D heritage. The bit-hack initial estimate
// gives ~3% precision; one Newton iteration brings it to ~0.2%. Magic constant
// 0x5f3759df is the canonical value; alternatives (0x5f375a86, etc.) trade
// initial-guess error for post-Newton error.
static inline float rune_fast_rsqrt(float number) {
  union { float f; uint32_t i; } conv;
  float x2 = number * 0.5f;
  conv.f = number;
  conv.i = 0x5f3759df - (conv.i >> 1);                    // initial estimate
  conv.f = conv.f * (1.5f - (x2 * conv.f * conv.f));       // 1× Newton refine
  return conv.f;
}

static inline void rune_normalise3_fast(float x, float y, float z,
                                         float* xn, float* yn, float* zn) {
  float inv = rune_fast_rsqrt(x * x + y * y + z * z);
  *xn = x * inv;
  *yn = y * inv;
  *zn = z * inv;
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

#if defined(RUNE_NORMALISE_FAST)
  #define RUNE_NORMALISE_VARIANT_NAME "fast"
  static inline void normalise3(float x, float y, float z,
                                 float* xn, float* yn, float* zn) {
    rune_normalise3_fast(x, y, z, xn, yn, zn);
  }
#else
  #define RUNE_NORMALISE_VARIANT_NAME "naive"
  static inline void normalise3(float x, float y, float z,
                                 float* xn, float* yn, float* zn) {
    rune_normalise3_naive(x, y, z, xn, yn, zn);
  }
#endif
