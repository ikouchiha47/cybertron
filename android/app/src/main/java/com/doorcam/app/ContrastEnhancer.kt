package com.doorcam.app

import android.graphics.Bitmap

/**
 * Contrast Limited Adaptive Histogram Equalization (CLAHE) for the person
 * detection input path.
 *
 * Operates in place on a mutable ARGB_8888 [Bitmap], equalizing only its
 * luminance (Rec.601). The chroma of every pixel is preserved by rescaling its
 * R/G/B so the resulting luma matches the equalized value while keeping the
 * original channel ratios. The display path is never touched — callers apply
 * this to the detection bitmap only.
 *
 * Implementation:
 *  - [tiles] x [tiles] histograms, each clipped at [clipLimit] times the tile's
 *    mean bin population, with the clipped excess redistributed evenly, then a
 *    CDF maps every luma level to its equalized value (the LUT).
 *  - Per-pixel mapping is bilinearly interpolated between the four nearest tile
 *    mappings (weights precomputed per row/column) to remove tile seams.
 *  - All scratch buffers (pixel/luma planes, histograms, LUTs, interpolation
 *    tables) are held in the object and only reallocated when the bitmap
 *    dimensions or tile count change. Integer/float math only; no per-pixel
 *    allocation.
 *  - Best effort: any failure is swallowed and the bitmap is left untouched
 *    (the pixel buffer is only written back to the bitmap at the very end).
 *
 * Not thread-safe: all calls must happen on the engine's single pipeline thread.
 */
object ContrastEnhancer {

    // Rec.601 luma approximation; weights sum to 256.
    private const val LUMA_R = 77
    private const val LUMA_G = 150
    private const val LUMA_B = 29

    private var cachedW = -1
    private var cachedH = -1
    private var cachedTiles = -1

    private var pixels = IntArray(0)
    private var luma = IntArray(0)
    private var hist = IntArray(0)
    private var lut = IntArray(0)
    private var tileCount = IntArray(0)

    private var xi0 = IntArray(0)
    private var xi1 = IntArray(0)
    private var xw = FloatArray(0)
    private var yi0 = IntArray(0)
    private var yi1 = IntArray(0)
    private var yw = FloatArray(0)

    /**
     * Enhances [bitmap] in place. [clipLimit] limits the histogram bins to
     * `clipLimit / 256` of the tile population (higher = stronger, less
     * clipping); [tiles] is the number of tiles per axis. Never throws.
     */
    fun enhance(bitmap: Bitmap, clipLimit: Float = 2.0f, tiles: Int = 8) {
        try {
            val w = bitmap.width
            val h = bitmap.height
            if (w <= 0 || h <= 0 || bitmap.isRecycled) return
            val t = tiles.coerceIn(1, 32)

            ensureCapacity(w, h, t)
            bitmap.getPixels(pixels, 0, w, 0, 0, w, h)

            buildLuma(w, h)
            buildTileLuts(w, h, t, clipLimit)
            applyMapping(w, h, t)

            bitmap.setPixels(pixels, 0, w, 0, 0, w, h)
        } catch (_: Throwable) {
            // Never throw; leave the bitmap as-is (best effort).
        }
    }

    private fun ensureCapacity(w: Int, h: Int, t: Int) {
        if (w == cachedW && h == cachedH && t == cachedTiles) return

        val n = w * h
        if (pixels.size != n) {
            pixels = IntArray(n)
            luma = IntArray(n)
        }
        if (xi0.size != w) {
            xi0 = IntArray(w)
            xi1 = IntArray(w)
            xw = FloatArray(w)
        }
        if (yi0.size != h) {
            yi0 = IntArray(h)
            yi1 = IntArray(h)
            yw = FloatArray(h)
        }
        val slots = t * t
        if (hist.size != slots * 256) {
            hist = IntArray(slots * 256)
            lut = IntArray(slots * 256)
        }
        if (tileCount.size != slots) tileCount = IntArray(slots)

        cachedW = w
        cachedH = h
        cachedTiles = t
        buildInterpTables(w, h, t)
    }

    /**
     * Precomputes, for every column/row, the two neighbouring tile indices and
     * the fractional weight between them, using tile-centre coordinates so the
     * bilinear blend is seamless across the whole frame.
     */
    private fun buildInterpTables(w: Int, h: Int, t: Int) {
        for (x in 0 until w) {
            val fx = (x + 0.5f) * t / w - 0.5f
            val base = kotlin.math.floor(fx).toInt()
            xi0[x] = base.coerceIn(0, t - 1)
            xi1[x] = (base + 1).coerceIn(0, t - 1)
            xw[x] = fx - base
        }
        for (y in 0 until h) {
            val fy = (y + 0.5f) * t / h - 0.5f
            val base = kotlin.math.floor(fy).toInt()
            yi0[y] = base.coerceIn(0, t - 1)
            yi1[y] = (base + 1).coerceIn(0, t - 1)
            yw[y] = fy - base
        }
    }

    private fun buildLuma(w: Int, h: Int) {
        val n = w * h
        var i = 0
        while (i < n) {
            val p = pixels[i]
            val r = (p shr 16) and 0xFF
            val g = (p shr 8) and 0xFF
            val b = p and 0xFF
            luma[i] = (LUMA_R * r + LUMA_G * g + LUMA_B * b) shr 8
            i++
        }
    }

    /** Builds the clipped CDF LUT for every tile. */
    private fun buildTileLuts(w: Int, h: Int, t: Int, clipLimit: Float) {
        hist.fill(0)
        val slots = t * t

        // Per-tile luminance histograms.
        var slot = 0
        for (ty in 0 until t) {
            val y0 = ty * h / t
            val y1 = (ty + 1) * h / t
            for (tx in 0 until t) {
                val x0 = tx * w / t
                val x1 = (tx + 1) * w / t
                val count = (x1 - x0) * (y1 - y0)
                tileCount[slot] = count
                val base = slot * 256
                var y = y0
                while (y < y1) {
                    var idx = y * w + x0
                    val end = y * w + x1
                    while (idx < end) {
                        hist[base + luma[idx]]++
                        idx++
                    }
                    y++
                }
                slot++
            }
        }

        val clip = if (clipLimit.isFinite()) clipLimit.coerceAtLeast(0f) else 0f
        for (s in 0 until slots) {
            val base = s * 256
            val count = tileCount[s]
            if (count <= 0) {
                // Degenerate (bitmap smaller than the tile grid): identity LUT.
                var b = 0
                while (b < 256) {
                    lut[base + b] = b
                    b++
                }
                continue
            }

            // Clip bins above the limit and remember the excess.
            val limit = maxOf(1, (clip * count / 256f).toInt())
            var excess = 0
            var b = 0
            while (b < 256) {
                val v = hist[base + b]
                if (v > limit) {
                    excess += v - limit
                    hist[base + b] = limit
                }
                b++
            }

            // Redistribute the clipped excess evenly, remainder to the low bins.
            val add = excess / 256
            var rem = excess - add * 256
            if (add > 0) {
                b = 0
                while (b < 256) {
                    hist[base + b] += add
                    b++
                }
            }
            b = 0
            while (rem > 0 && b < 256) {
                hist[base + b]++
                rem--
                b++
            }

            // CDF -> equalized LUT (0..255).
            var cum = 0
            b = 0
            while (b < 256) {
                cum += hist[base + b]
                lut[base + b] = (cum * 255) / count
                b++
            }
        }
    }

    /** Applies the bilinearly interpolated tile mapping to every pixel. */
    private fun applyMapping(w: Int, h: Int, t: Int) {
        var idx = 0
        var y = 0
        while (y < h) {
            val row0 = yi0[y] * t
            val row1 = yi1[y] * t
            val fy = yw[y]
            var x = 0
            while (x < w) {
                val l = luma[idx]
                val c0 = xi0[x]
                val c1 = xi1[x]
                val fx = xw[x]

                val v00 = lut[((row0 + c0) shl 8) + l]
                val v01 = lut[((row0 + c1) shl 8) + l]
                val v10 = lut[((row1 + c0) shl 8) + l]
                val v11 = lut[((row1 + c1) shl 8) + l]
                val top = v00 + (v01 - v00) * fx
                val bot = v10 + (v11 - v10) * fx
                val mapped = top + (bot - top) * fy

                val p = pixels[idx]
                val a = p ushr 24
                val newL = (mapped + 0.5f).toInt().coerceIn(0, 255)
                if (l > 0) {
                    if (newL != l) {
                        // Multiplicative rescale: keep R:G:B ratios, match luma.
                        val scale = newL.toFloat() / l
                        val r = (((p shr 16) and 0xFF) * scale + 0.5f).toInt().coerceIn(0, 255)
                        val g = (((p shr 8) and 0xFF) * scale + 0.5f).toInt().coerceIn(0, 255)
                        val b = ((p and 0xFF) * scale + 0.5f).toInt().coerceIn(0, 255)
                        pixels[idx] = (a shl 24) or (r shl 16) or (g shl 8) or b
                    }
                } else {
                    // Pitch black has no ratios to preserve: emit neutral gray.
                    pixels[idx] = (a shl 24) or (newL shl 16) or (newL shl 8) or newL
                }

                idx++
                x++
            }
            y++
        }
    }
}
