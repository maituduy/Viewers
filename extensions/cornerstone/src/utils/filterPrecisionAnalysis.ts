import * as cornerstone from '@cornerstonejs/core';
import { StackViewport, metaData } from '@cornerstonejs/core';

export type FilterKernelName = 'none' | 'sharpen' | 'blur' | 'emboss' | 'edges';

export interface PrecisionReport {
  filterType: FilterKernelName;
  width: number;
  height: number;
  inputBitDepth: string;
  /** Mean absolute error per pixel (in display [0,255] scale) */
  meanAbsError: number;
  /** Standard deviation of per-pixel error (in [0,255] scale) */
  stdDev: number;
  /** Maximum absolute error in any single pixel (in [0,255] scale) */
  maxError: number;
  /** PSNR in dB — higher = better (>40 dB is excellent) */
  psnr: number;
  /** Total pixels analysed */
  pixelCount: number;
}

const KERNELS: Record<FilterKernelName, number[]> = {
  none:    [0,  0, 0,  0,  1, 0,  0,  0, 0],
  sharpen: [0, -1, 0, -1,  5,-1,  0, -1, 0],
  blur:    [1,  1, 1,  1,  1, 1,  1,  1, 1],  // weight=9, normalised below
  emboss:  [-2,-1, 0, -1,  1, 1,  0,  1, 2],
  edges:   [-1,-1,-1, -1,  8,-1, -1, -1,-1],
};

const KERNEL_WEIGHTS: Record<FilterKernelName, number> = {
  none:    1,
  sharpen: 1,
  blur:    9,
  emboss:  0,
  edges:   0,
};

/**
 * Apply a 3x3 convolution kernel to a Float32Array of pixel values in [0,1].
 * Returns a new Float32Array of the same length.
 */
function applyKernelCPU(
  data: Float32Array,
  width: number,
  height: number,
  kernel: number[],
  weight: number
): Float32Array {
  const out = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let ky = 0; ky < 3; ky++) {
        for (let kx = 0; kx < 3; kx++) {
          const sy = Math.min(Math.max(y + ky - 1, 0), height - 1);
          const sx = Math.min(Math.max(x + kx - 1, 0), width - 1);
          sum += data[sy * width + sx] * kernel[ky * 3 + kx];
        }
      }
      const result = weight > 0 ? sum / weight : sum;
      out[y * width + x] = Math.min(Math.max(result, 0), 1);
    }
  }

  return out;
}

/**
 * Compare filter quality: raw 16-bit path vs 8-bit canvas path.
 *
 * Path A (reference — maximum precision):
 *   raw 16-bit DICOM pixels → apply linear VOI/LUT → Float32 [0,1] → convolution
 *
 * Path B (actual — what the current filter does):
 *   canvas 8-bit RGBA → extract R channel → Float32 [0,1] → convolution
 *
 * Returns a PrecisionReport with mean error, std dev, max error, PSNR.
 */
export function measureFilterPrecision(
  viewportId: string,
  filterType: FilterKernelName,
  canvasElement: HTMLCanvasElement
): PrecisionReport | null {
  try {
    // ── Step 1: Get Cornerstone viewport ────────────────────────────────────
    const enabledElement = cornerstone.getEnabledElementByViewportId(viewportId);
    if (!enabledElement) {
      console.warn('[PrecisionAnalysis] No enabled element for viewportId:', viewportId);
      return null;
    }

    const { viewport } = enabledElement;

    if (!(viewport instanceof StackViewport)) {
      console.warn('[PrecisionAnalysis] Only StackViewport is supported');
      return null;
    }

    // ── Step 2: Get raw pixel data from Cornerstone cache ───────────────────
    const imageId = (viewport as StackViewport).getCurrentImageId();
    const image = cornerstone.cache.getImage(imageId);

    if (!image) {
      console.warn('[PrecisionAnalysis] Image not found in cache:', imageId);
      return null;
    }

    const rawPixels = image.getPixelData() as unknown as ArrayLike<number>;
    const width = image.width;
    const height = image.height;

    // ── Step 3: Get VOI range from viewport ────────────────────────────────
    const properties = viewport.getProperties();
    const { voiRange } = properties;

    if (!voiRange) {
      console.warn('[PrecisionAnalysis] No voiRange on viewport');
      return null;
    }

    const { lower, upper } = voiRange;
    const range = upper - lower;

    if (range === 0) {
      console.warn('[PrecisionAnalysis] voiRange has zero width');
      return null;
    }

    // Detect actual bit depth from pixel data type
    const buf = image.getPixelData();
    const inputBitDepth =
      buf instanceof Int16Array    ? '16-bit signed (Int16)'    :
      buf instanceof Uint16Array   ? '16-bit unsigned (Uint16)' :
      buf instanceof Int32Array    ? '32-bit signed (Int32)'    :
      buf instanceof Uint8Array    ? '8-bit unsigned (Uint8)'   :
      buf instanceof Float32Array  ? '32-bit float (Float32)'   :
      `Unknown (${Object.prototype.toString.call(buf)})`;

    // ── Step 4: Raw pixels → HU (slope/intercept) → normalise via VOI ───────
    // Must apply modality rescale BEFORE VOI because voiRange is in HU space.
    const modalityModule = metaData.get('modalityLutModule', imageId);
    const slope: number    = modalityModule?.rescaleSlope     ?? (image as any).slope     ?? 1;
    const intercept: number = modalityModule?.rescaleIntercept ?? (image as any).intercept ?? 0;

    const raw16Norm = new Float32Array(width * height);
    for (let i = 0; i < raw16Norm.length; i++) {
      const hu = rawPixels[i] * slope + intercept;
      raw16Norm[i] = Math.min(Math.max((hu - lower) / range, 0), 1);
    }

    // ── Step 5: Apply convolution to 16-bit normalised data (Path A) ────────
    const kernel = KERNELS[filterType];
    const weight = KERNEL_WEIGHTS[filterType];
    const filtered16 = applyKernelCPU(raw16Norm, width, height, kernel, weight);

    // ── Step 6: Get 8-bit RGBA from canvas ──────────────────────────────────
    const ctx = canvasElement.getContext('2d');
    if (!ctx) {
      console.warn('[PrecisionAnalysis] Cannot get 2D context from canvas');
      return null;
    }

    // Canvas may have devicePixelRatio scaling — read at CSS pixel size
    const imgData = ctx.getImageData(0, 0, canvasElement.width, canvasElement.height);

    // If canvas dimensions differ from image dimensions (DPR scaling), resample
    // For simplicity we take the first min(w,h) matching region
    const cw = canvasElement.width;
    const ch = canvasElement.height;
    const sampleW = Math.min(width, cw);
    const sampleH = Math.min(height, ch);

    // Normalise canvas R channel to [0,1]  (grayscale DICOM: R=G=B)
    const canvas8Norm = new Float32Array(sampleW * sampleH);
    for (let y = 0; y < sampleH; y++) {
      for (let x = 0; x < sampleW; x++) {
        canvas8Norm[y * sampleW + x] = imgData.data[(y * cw + x) * 4] / 255;
      }
    }

    // ── Step 7: Apply same convolution to 8-bit data (Path B) ───────────────
    const filtered8 = applyKernelCPU(canvas8Norm, sampleW, sampleH, kernel, weight);

    // ── Step 8: Trim reference to sample region ──────────────────────────────
    const ref = new Float32Array(sampleW * sampleH);
    for (let y = 0; y < sampleH; y++) {
      for (let x = 0; x < sampleW; x++) {
        ref[y * sampleW + x] = filtered16[y * width + x];
      }
    }

    // ── Step 9: Compute error statistics ────────────────────────────────────
    const pixelCount = sampleW * sampleH;
    let sumAbsErr = 0;
    let sumSqErr = 0;
    let maxErr = 0;

    for (let i = 0; i < pixelCount; i++) {
      const diff = Math.abs(ref[i] - filtered8[i]);
      sumAbsErr += diff;
      sumSqErr += diff * diff;
      if (diff > maxErr) maxErr = diff;
    }

    const meanAbsError = (sumAbsErr / pixelCount) * 255;
    const mse = sumSqErr / pixelCount;
    const rmse = Math.sqrt(mse);

    // Std dev of per-pixel error (in [0,255] scale)
    // E[X^2] - E[X]^2  → but simpler: stdDev ≈ rmse*255 for zero-mean error
    const meanErr = sumAbsErr / pixelCount;
    let sumSqDev = 0;
    for (let i = 0; i < pixelCount; i++) {
      const diff = Math.abs(ref[i] - filtered8[i]);
      sumSqDev += (diff - meanErr) * (diff - meanErr);
    }
    const stdDev = Math.sqrt(sumSqDev / pixelCount) * 255;

    // PSNR = 10 * log10(MAX^2 / MSE)  — MAX = 1.0 in normalised scale
    const psnr = mse === 0 ? Infinity : 10 * Math.log10(1 / mse);

    return {
      filterType,
      width: sampleW,
      height: sampleH,
      inputBitDepth,
      meanAbsError: +meanAbsError.toFixed(4),
      stdDev: +stdDev.toFixed(4),
      maxError: +(maxErr * 255).toFixed(4),
      psnr: +psnr.toFixed(2),
      pixelCount,
    };
  } catch (err) {
    console.error('[PrecisionAnalysis] Error:', err);
    return null;
  }
}
