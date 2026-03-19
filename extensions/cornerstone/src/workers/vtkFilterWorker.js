/**
 * VTK Filter Worker  (v6 — canvas-pixel convolution)
 *
 * Receives the canvas RGBA pixels ALREADY rendered by Cornerstone, applies the
 * 3×3 convolution kernel off-thread, and returns the filtered RGBA buffer.
 *
 * Why pass canvas pixels instead of raw HU?
 * ──────────────────────────────────────────
 * Cornerstone applies a full rendering pipeline before painting the canvas:
 *   raw DICOM pixels → slope/intercept → VOI range → DICOM VOI LUT → colormap
 * Replicating this from scratch always diverges, making VTK look different.
 * Taking already-rendered pixels removes that divergence entirely.
 *
 * VTK advantage: convolution runs off the UI thread (no jank on large canvases),
 * result is cached → subsequent re-renders are instant.
 */

import { expose } from 'comlink';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';

/**
 * Apply a 3×3 convolution kernel on Float32 grayscale data via vtkImageData.
 *
 * @param {Float32Array} data    – input [0,1] grayscale, length = W*H
 * @param {number}       W      – canvas width
 * @param {number}       H      – canvas height
 * @param {number[]}     kernel – 3×3 row-major, 9 values
 * @param {number}       weight – normalization divisor (0 = skip)
 * @returns {Float32Array}       – convolved output, same size
 */
function convolveVTK(data, W, H, kernel, weight) {
  // Wrap in vtkImageData — canonical VTK pipeline boundary
  const inputVTK = vtkImageData.newInstance();
  inputVTK.setDimensions([W, H, 1]);
  inputVTK.setSpacing([1, 1, 1]);
  inputVTK.setOrigin([0, 0, 0]);
  inputVTK.setDirection([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  inputVTK.getPointData().setScalars(
    vtkDataArray.newInstance({ name: 'px', numberOfComponents: 1, values: data })
  );
  inputVTK.modified();

  const src = inputVTK.getPointData().getScalars().getData();
  const out  = new Float32Array(W * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let ky = 0; ky < 3; ky++) {
        for (let kx = 0; kx < 3; kx++) {
          const sy = Math.min(Math.max(y + ky - 1, 0), H - 1);
          const sx = Math.min(Math.max(x + kx - 1, 0), W - 1);
          sum += src[sy * W + sx] * kernel[ky * 3 + kx];
        }
      }
      out[y * W + x] = weight > 0 ? sum / weight : sum;
    }
  }
  return out;
}

// ── Worker API ────────────────────────────────────────────────────────────────
const api = {
  /**
   * Apply a convolution filter to already-rendered Cornerstone canvas pixels.
   *
   * @param {Object}      params
   * @param {ArrayBuffer} params.rgbaBuffer     – canvas ImageData buffer (Uint8ClampedArray)
   * @param {number}      params.canvasWidth
   * @param {number}      params.canvasHeight
   * @param {number[]}    params.kernel          – 3×3 row-major kernel
   * @param {number}      params.kernelWeight    – normalization divisor
   * @param {number}      params.kernelStrength  – blend factor 0..1
   *
   * @returns {{ rgbaBuffer: ArrayBuffer, canvasWidth, canvasHeight }}
   */
  applyFilter({ rgbaBuffer, canvasWidth: W, canvasHeight: H, kernel, kernelWeight, kernelStrength }) {
    const src = new Uint8ClampedArray(rgbaBuffer);

    // ── Step 1: RGBA → grayscale float [0,1] ─────────────────────────────────
    // Cornerstone renders grayscale: R=G=B, so just use R channel
    const gray = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      gray[i] = src[i * 4] / 255;
    }

    // ── Step 2: VTK 3×3 convolution ──────────────────────────────────────────
    const filtered = convolveVTK(gray, W, H, kernel, kernelWeight);

    // ── Step 3: mix(original, filtered, strength) → clamp → RGBA ─────────────
    // Mirrors WebGL: `result = mix(original.rgb, filtered, u_strength)`
    const out = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      let v = gray[i] + kernelStrength * (filtered[i] - gray[i]);
      if (v < 0) v = 0;
      if (v > 1) v = 1;
      const byte = (v * 255 + 0.5) | 0;
      const idx  = i * 4;
      out[idx]     = byte;
      out[idx + 1] = byte;
      out[idx + 2] = byte;
      out[idx + 3] = src[i * 4 + 3]; // preserve Cornerstone's alpha
    }

    return { rgbaBuffer: out.buffer, canvasWidth: W, canvasHeight: H };
  },
};

expose(api);
