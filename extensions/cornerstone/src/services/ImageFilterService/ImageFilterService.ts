import { PubSubService } from '@ohif/core';
import { Types as OhifTypes } from '@ohif/core';
import * as cornerstone from '@cornerstonejs/core';
import { utilities as csUtilities, metaData } from '@cornerstonejs/core';
import { wrap, transfer } from 'comlink';

export type FilterType = 'none' | 'sharpen' | 'blur' | 'emboss' | 'edges';

interface FilterState {
  [viewportId: string]: {
    filterType: FilterType;
    canvas?: HTMLCanvasElement;
    gl?: WebGLRenderingContext;
    program?: WebGLProgram;
    texture?: WebGLTexture;
  };
}

const EVENTS = {
  FILTER_CHANGED: 'event::imageFilterService:filterChanged',
};

/**
 * Image Filter Service using WebGL for high-performance real-time filtering
 * Supports: Sharpen, Blur, Emboss, Edge Detection
 */
class ImageFilterService extends PubSubService {
  static REGISTRATION = {
    name: 'imageFilterService',
    altName: 'ImageFilterService',
    create: ({ servicesManager }: OhifTypes.Extensions.ExtensionParams): ImageFilterService => {
      return new ImageFilterService(servicesManager);
    },
  };

  private filterState: FilterState = {};
  private servicesManager: AppTypes.ServicesManager;

  // Vertex shader - flip Y to match canvas coordinate system (top-left origin)
  private vertexShaderSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    varying vec2 v_texCoord;

    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      v_texCoord = vec2(a_texCoord.x, 1.0 - a_texCoord.y);
    }
  `;

  // Fragment shader with convolution kernel support
  // precision highp float: 32-bit float on GPU (vs mediump ~10-bit) — preserves full 8-bit channel accuracy
  private fragmentShaderSource = `
    precision highp float;

    uniform sampler2D u_image;
    uniform vec2 u_textureSize;
    uniform float u_kernel[9];
    uniform float u_kernelWeight;
    uniform float u_strength;   // 0.0 = original, 1.0 = full filter effect

    varying vec2 v_texCoord;

    void main() {
      vec4 original = texture2D(u_image, v_texCoord);
      vec2 onePixel = vec2(1.0) / u_textureSize;
      vec4 colorSum = vec4(0.0);

      // Apply 3x3 convolution kernel
      for(int i = 0; i < 3; i++) {
        for(int j = 0; j < 3; j++) {
          vec2 offset = vec2(float(j - 1), float(i - 1)) * onePixel;
          colorSum += texture2D(u_image, v_texCoord + offset) * u_kernel[i * 3 + j];
        }
      }

      // Normalize by kernel weight if positive (prevents brightness shift)
      vec3 filtered = (u_kernelWeight > 0.0) ? colorSum.rgb / u_kernelWeight : colorSum.rgb;

      // Blend original with filtered result — prevents over-sharpening on noisy images
      vec3 result = mix(original.rgb, filtered, u_strength);
      gl_FragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
    }
  `;

  // Convolution kernels for different filters
  private kernels: Record<string, number[]> = {
    none:    [0, 0, 0,  0,  1, 0,  0, 0, 0],
    sharpen: [0, -1, 0, -1, 5, -1, 0, -1, 0],
    blur:    [1, 1, 1,  1,  1, 1,  1, 1, 1],  // weight=9, shader divides → true box blur, no precision loss
    emboss:  [-2, -1, 0, -1, 1, 1, 0, 1, 2],
    edges:   [-1, -1, -1, -1, 8, -1, -1, -1, -1],
  };

  // kernelWeight: sum of positive kernel values, used to normalize output
  // Prevents brightness shift and keeps result in [0,1] range
  private kernelWeights: Record<string, number> = {
    none:    1,
    sharpen: 1,   // sum = 5-4 = 1, self-normalizing
    blur:    9,   // 9 × (1/9) = 1 → shader divides by 9
    emboss:  0,   // no normalization — emboss is a directional effect
    edges:   0,   // no normalization — edges center is 8, result can go negative → clamped
  };

  // kernelStrength: how much to blend filtered vs original (u_strength in shader)
  // - 1.0 = full filter effect
  // - 0.5 = 50% blend (gentler, avoids noise amplification on wide-window CT)
  private kernelStrengths: Record<string, number> = {
    none:    1.0,
    sharpen: 0.5,  // unsharp-mask style: half blend prevents noise explosion on bone windows
    blur:    1.0,
    emboss:  1.0,
    edges:   1.0,
  };

  // ── VTK Worker (16-bit precision, off-main-thread) ─────────────────────────
  /** Raw Worker instance — kept alive to avoid cold-start cost on each render */
  private _vtkWorkerInstance: Worker | null = null;
  /** Comlink proxy wrapping the worker's exposed API */
  private _vtkProxy: any = null;
  /**
   * Result cache: cacheKey → ImageData
   * Key format: `${imageId}|${filterType}|${voiLower}|${voiUpper}|${invert}|${cw}x${ch}`
   * One entry per unique combination — avoids re-running the worker on every
   * re-render when nothing has changed (e.g. cursor move, panel open/close).
   */
  private _vtkCache: Map<string, ImageData> = new Map();
  /** Maximum cache entries (LRU eviction) */
  private static readonly VTK_CACHE_MAX = 8;
  /**
   * Bump this whenever the worker pipeline logic changes.
   * Old cached ImageData entries become invalid and will be recomputed.
   */
  private static readonly VTK_WORKER_VERSION = 6; // v6: pass canvas pixels, not HU data
  /**
   * Global switch for VTK worker path.
   * - true  (default): StackViewport uses VTK worker + cache.
   * - false: force WebGL filter path for all viewports.
   */
  private static VTK_FILTER_ENABLED = true;

  constructor(servicesManager: AppTypes.ServicesManager) {
    super(EVENTS);
    this.servicesManager = servicesManager;
  }

  /** Enable/disable VTK filter pipeline globally (default: true). */
  public setVTKFilterEnabled(enabled: boolean): void {
    ImageFilterService.VTK_FILTER_ENABLED = enabled;
    if (!enabled) {
      // Avoid stale cache usage when toggling off/on in the same session.
      this._vtkCache.clear();
    }
  }

  /** Returns whether VTK filter pipeline is globally enabled. */
  public isVTKFilterEnabled(): boolean {
    return ImageFilterService.VTK_FILTER_ENABLED;
  }

  /**
   * Initialize WebGL context for a viewport
   */
  private initWebGL(viewportId: string, sourceCanvas: HTMLCanvasElement): boolean {
    try {
      // Create off-screen canvas for WebGL processing
      const canvas = document.createElement('canvas');
      canvas.width = sourceCanvas.width;
      canvas.height = sourceCanvas.height;

      const gl = canvas.getContext('webgl', {
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      }) as WebGLRenderingContext;

      if (!gl) {
        console.error('WebGL not supported');
        return false;
      }

      // Compile shaders
      const vertexShader = this.compileShader(gl, gl.VERTEX_SHADER, this.vertexShaderSource);
      const fragmentShader = this.compileShader(
        gl,
        gl.FRAGMENT_SHADER,
        this.fragmentShaderSource
      );

      if (!vertexShader || !fragmentShader) {
        return false;
      }

      // Create and link program
      const program = gl.createProgram();
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Program link error:', gl.getProgramInfoLog(program));
        return false;
      }

      // Set up geometry (full-screen quad)
      const positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW
      );

      const texCoordBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
        gl.STATIC_DRAW
      );

      // Create texture
      // NEAREST: no interpolation between pixels — preserves exact 8-bit values from source canvas
      // LINEAR would introduce sub-pixel blending (averaging neighboring pixels), causing precision loss
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      // Store WebGL state
      this.filterState[viewportId] = {
        ...this.filterState[viewportId], // Preserve existing filterType if any
        filterType: this.filterState[viewportId]?.filterType || 'none',
        canvas,
        gl,
        program,
        texture,
      };

      // Set up attribute locations
      const positionLocation = gl.getAttribLocation(program, 'a_position');
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

      const texCoordLocation = gl.getAttribLocation(program, 'a_texCoord');
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.enableVertexAttribArray(texCoordLocation);
      gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

      return true;
    } catch (error) {
      console.error('WebGL initialization error:', error);
      return false;
    }
  }

  /**
   * Compile shader
   */
  private compileShader(
    gl: WebGLRenderingContext,
    type: number,
    source: string
  ): WebGLShader | null {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compilation error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }

    return shader;
  }

  /**
   * Apply filter to canvas using WebGL
   */
  public applyFilter(
    viewportId: string,
    sourceCanvas: HTMLCanvasElement,
    filterType: FilterType
  ): HTMLCanvasElement | null {
    try {
      // Validate inputs
      if (!sourceCanvas || !sourceCanvas.width || !sourceCanvas.height) {
        return null;
      }

      // Initialize WebGL if needed (check if WebGL resources exist, not just state)
      if (!this.filterState[viewportId] || !this.filterState[viewportId].gl) {
        if (!this.initWebGL(viewportId, sourceCanvas)) {
          return null;
        }
      }

      const state = this.filterState[viewportId];

      if (!state || !state.canvas || !state.gl || !state.program) {
        return null;
      }

      const { canvas, gl, program, texture } = state;

      // Update canvas size if changed
      if (canvas.width !== sourceCanvas.width || canvas.height !== sourceCanvas.height) {
        canvas.width = sourceCanvas.width;
        canvas.height = sourceCanvas.height;
        gl.viewport(0, 0, canvas.width, canvas.height);
      }

      // Use program
      gl.useProgram(program);

      // Upload source canvas as texture
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);

      // Set uniforms
      const textureSizeLocation = gl.getUniformLocation(program, 'u_textureSize');
      gl.uniform2f(textureSizeLocation, sourceCanvas.width, sourceCanvas.height);

      const kernelLocation = gl.getUniformLocation(program, 'u_kernel[0]');
      const kernel = this.kernels[filterType] || this.kernels.none;
      gl.uniform1fv(kernelLocation, kernel);

      const kernelWeightLocation = gl.getUniformLocation(program, 'u_kernelWeight');
      const kernelWeight = this.kernelWeights[filterType] ?? 0;
      gl.uniform1f(kernelWeightLocation, kernelWeight);

      const strengthLocation = gl.getUniformLocation(program, 'u_strength');
      const strength = this.kernelStrengths[filterType] ?? 1.0;
      gl.uniform1f(strengthLocation, strength);

      // Draw
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Update state
      state.filterType = filterType;

      return canvas;
    } catch (error) {
      console.error('Error applying filter:', error);
      return null;
    }
  }

  /**
   * CPU convolution kernel — operates on raw float values (HU or normalised).
   * Used by the 16-bit path before VOI/LUT mapping.
   */
  private _applyKernelCPU(
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
        out[y * width + x] = weight > 0 ? sum / weight : sum;
      }
    }
    return out;
  }

  /**
   * 16-bit filter path (true precision):
   *   raw 16-bit DICOM pixels → rescale slope/intercept → convolution (CPU, Float32)
   *   → VOI/LUT map to [0,255] → canvas ImageData
   *
   * Advantage over the WebGL 8-bit path: convolution happens BEFORE VOI quantisation,
   * so subtle HU differences (e.g. soft tissue ΔHU < 1) are preserved.
   *
   * Geometric transform (pan/zoom/rotation/flip) is replicated by computing an
   * affine canvas→image mapping from three reference points via Cornerstone's API.
   *
   * @param viewportId  - viewport id
   * @param viewport    - Cornerstone StackViewport instance
   * @param canvasEl    - the HTML canvas element of the viewport
   * @param filterType  - which kernel to apply
   * @returns ImageData ready for ctx.putImageData(), or null on failure
   */
  public applyFilter16bit(
    viewportId: string,
    viewport: any,
    canvasEl: HTMLCanvasElement,
    filterType: FilterType
  ): ImageData | null {
    try {
      const imageId: string = viewport.getCurrentImageId?.();
      if (!imageId) return null;

      const image = cornerstone.cache.getImage(imageId);
      if (!image) return null;

      const rawPixels = image.getPixelData() as unknown as ArrayLike<number>;
      const imgW: number = image.width;
      const imgH: number = image.height;

      // Step 1a: Get slope/intercept from DICOM metadata (reliable source).
      // image.slope / image.intercept may be null/undefined in Cornerstone3D cache.
      const modalityModule = metaData.get('modalityLutModule', imageId);
      const slope: number   = modalityModule?.rescaleSlope     ?? (image as any).slope     ?? 1;
      const intercept: number = modalityModule?.rescaleIntercept ?? (image as any).intercept ?? 0;

      // Step 1b: invert flag comes from viewport properties, not from image object.
      const vprops = viewport.getProperties?.() ?? {};
      const invert: boolean = vprops.invert ?? false;

      // Step 1c: Raw pixels → modality values (HU for CT) via rescale
      const huData = new Float32Array(imgW * imgH);
      for (let i = 0; i < huData.length; i++) {
        huData[i] = rawPixels[i] * slope + intercept;
      }

      // Step 2: Apply convolution kernel on HU values
      const kernel = this.kernels[filterType] || this.kernels.none;
      const weight = this.kernelWeights[filterType] ?? 0;
      const filteredHU = this._applyKernelCPU(huData, imgW, imgH, kernel, weight);

      // Step 3: Get VOI range (in HU / modality LUT output space)
      // vprops was already fetched above alongside invert
      const voiRange = vprops.voiRange;
      if (!voiRange) return null;
      const { lower, upper } = voiRange as { lower: number; upper: number };
      const range = upper - lower;
      if (range === 0) return null;

      // Step 4: Compute affine canvas→image transform from 3 reference points.
      //
      // IMPORTANT: canvasToWorld() expects CSS pixel coordinates (device-independent),
      // but canvas.width/height are PHYSICAL pixels (CSS × devicePixelRatio).
      // Passing physical pixels directly causes the affine to be wrong by a factor of DPR,
      // making the image appear collapsed into the top-left corner.
      //
      // Fix: use clientWidth/clientHeight (CSS) for canvasToWorld reference points,
      // then derive per-physical-pixel step by dividing by DPR.
      const cw = canvasEl.width;   // physical pixels → ImageData output size
      const ch = canvasEl.height;
      const cssW = canvasEl.clientWidth  || cw;  // CSS pixels → canvasToWorld input
      const cssH = canvasEl.clientHeight || ch;

      const w0 = viewport.canvasToWorld([0,    0   ]);
      const w1 = viewport.canvasToWorld([cssW, 0   ]);
      const w2 = viewport.canvasToWorld([0,    cssH]);
      const i0 = csUtilities.worldToImageCoords(imageId, w0); // [col, row]
      const i1 = csUtilities.worldToImageCoords(imageId, w1);
      const i2 = csUtilities.worldToImageCoords(imageId, w2);

      // Affine step per CSS pixel
      const dColDxCss = (i1[0] - i0[0]) / cssW;
      const dRowDxCss = (i1[1] - i0[1]) / cssW;
      const dColDyCss = (i2[0] - i0[0]) / cssH;
      const dRowDyCss = (i2[1] - i0[1]) / cssH;

      // Convert to step per physical pixel (divide by DPR)
      const dprX = cw / cssW;
      const dprY = ch / cssH;
      const dColDx = dColDxCss / dprX;
      const dRowDx = dRowDxCss / dprX;
      const dColDy = dColDyCss / dprY;
      const dRowDy = dRowDyCss / dprY;

      // Step 5: Render each canvas pixel via bilinear sample + VOI
      const outputData = new ImageData(cw, ch);
      const buf = outputData.data;

      for (let cy = 0; cy < ch; cy++) {
        const baseCol = i0[0] + cy * dColDy;
        const baseRow = i0[1] + cy * dRowDy;
        for (let cx = 0; cx < cw; cx++) {
          const fCol = baseCol + cx * dColDx;
          const fRow = baseRow + cx * dRowDx;

          // Bilinear interpolation
          const x0 = Math.floor(fCol);
          const y0 = Math.floor(fRow);
          const sx0 = Math.max(0, Math.min(imgW - 1, x0));
          const sy0 = Math.max(0, Math.min(imgH - 1, y0));
          const sx1 = Math.max(0, Math.min(imgW - 1, x0 + 1));
          const sy1 = Math.max(0, Math.min(imgH - 1, y0 + 1));
          const tx = fCol - x0;
          const ty = fRow - y0;

          const hu =
            filteredHU[sy0 * imgW + sx0] * (1 - tx) * (1 - ty) +
            filteredHU[sy0 * imgW + sx1] * tx * (1 - ty) +
            filteredHU[sy1 * imgW + sx0] * (1 - tx) * ty +
            filteredHU[sy1 * imgW + sx1] * tx * ty;

          // VOI/LUT: linear map → [0,1] → clamp → optional invert
          let v = (hu - lower) / range;
          if (v < 0) v = 0;
          if (v > 1) v = 1;
          if (invert) v = 1 - v;
          const byte = (v * 255 + 0.5) | 0;

          const idx = (cy * cw + cx) * 4;
          buf[idx]     = byte; // R
          buf[idx + 1] = byte; // G
          buf[idx + 2] = byte; // B
          buf[idx + 3] = 255;  // A (fully opaque)
        }
      }

      return outputData;
    } catch (err) {
      console.error('[ImageFilterService] applyFilter16bit error:', err);
      return null;
    }
  }

  // ── VTK Worker helpers ────────────────────────────────────────────────────

  /**
   * Lazy-init the VTK filter worker + comlink proxy.
   * The worker is kept alive between calls to amortise startup cost.
   */
  private _getVTKProxy(): any {
    if (!this._vtkProxy) {
      this._vtkWorkerInstance = new Worker(
        new URL('../../workers/vtkFilterWorker.js', import.meta.url),
        { name: 'vtk-filter-worker' }
      );
      this._vtkProxy = wrap(this._vtkWorkerInstance);
    }
    return this._vtkProxy;
  }

  /** Build the cache key for a given render configuration. */
  private _vtkCacheKey(
    imageId: string,
    filterType: string,
    voiLower: number,
    voiUpper: number,
    invert: boolean,
    cw: number,
    ch: number
  ): string {
    return `v${ImageFilterService.VTK_WORKER_VERSION}|${imageId}|${filterType}|${voiLower.toFixed(0)}|${voiUpper.toFixed(0)}|${invert}|${cw}x${ch}`;
  }

  /** Insert into cache; evict oldest entry when cap is reached. */
  private _vtkCacheSet(key: string, imageData: ImageData): void {
    if (this._vtkCache.size >= ImageFilterService.VTK_CACHE_MAX) {
      // Map insertion order → delete the oldest key
      const firstKey = this._vtkCache.keys().next().value;
      this._vtkCache.delete(firstKey);
    }
    this._vtkCache.set(key, imageData);
  }

  /**
   * Synchronous cache peek — returns immediately without spawning any work.
   * Used by ViewportFilterRenderer to check if a VTK result is already ready
   * so it can be painted synchronously inside IMAGE_RENDERED (before browser paint).
   *
   * @returns ImageData from cache, or null if not yet computed.
   */
  public peekVTKCache(
    viewportId: string,
    viewport: any,
    canvasEl: HTMLCanvasElement,
    filterType: FilterType
  ): ImageData | null {
    if (filterType === 'none') return null;
    try {
      const imageId: string = viewport.getCurrentImageId?.();
      if (!imageId) return null;

      const vprops   = viewport.getProperties?.() ?? {};
      const voiRange = vprops.voiRange as { lower: number; upper: number } | undefined;
      if (!voiRange) return null;

      const key = this._vtkCacheKey(
        imageId, filterType,
        voiRange.lower, voiRange.upper,
        vprops.invert ?? false,
        canvasEl.width, canvasEl.height
      );
      return this._vtkCache.get(key) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Apply filter using the VTK WebWorker pipeline (16-bit HU precision,
   * non-blocking).
   *
   * This is the recommended path for StackViewports:
   *  - Convolution happens on raw HU values BEFORE VOI quantisation
   *  - The heavy loop runs off the main thread → no UI jank
   *  - Results are cached: subsequent re-renders with the same params are
   *    served synchronously from cache (zero worker round-trip)
   *
   * Caller responsibilities:
   *  - Call this method on IMAGE_RENDERED (or equivalent)
   *  - On first invocation (cache miss), apply the cheap 8-bit WebGL filter
   *    as a placeholder, then call `viewport.render()` when the Promise resolves
   *    to show the high-quality result on the next frame.
   *
   * @returns Promise<ImageData | null>  null on error or if 'none' filter
   */
  public async applyFilterVTK(
    viewportId: string,
    viewport: any,
    canvasEl: HTMLCanvasElement,
    filterType: FilterType
  ): Promise<ImageData | null> {
    if (filterType === 'none') return null;

    try {
      // ── 1. Get rendered canvas pixels (Cornerstone's output) ──────────────
      const ctx = canvasEl.getContext('2d');
      if (!ctx) return null;

      const cw = canvasEl.width;
      const ch = canvasEl.height;
      if (!cw || !ch) return null;

      // ── 2. Build cache key (include VOI so stale cache is busted on W/L change)
      const imageId: string = viewport.getCurrentImageId?.();
      if (!imageId) return null;

      const vprops   = viewport.getProperties?.() ?? {};
      const voiRange = vprops.voiRange as { lower: number; upper: number } | undefined;
      const voiLower = voiRange?.lower ?? 0;
      const voiUpper = voiRange?.upper ?? 255;

      const cacheKey = this._vtkCacheKey(imageId, filterType, voiLower, voiUpper, vprops.invert ?? false, cw, ch);
      const cached   = this._vtkCache.get(cacheKey);
      if (cached) return cached;

      // ── 3. Read canvas pixels — this captures Cornerstone's full LUT/VOI output
      const sourceImageData = ctx.getImageData(0, 0, cw, ch);

      // ── 4. Hand off to VTK worker (Transferable: zero-copy buffer) ────────
      const proxy = this._getVTKProxy();
      const result = await proxy.applyFilter(
        transfer(
          {
            rgbaBuffer:     sourceImageData.data.buffer,
            canvasWidth:    cw,
            canvasHeight:   ch,
            kernel:         this.kernels[filterType]         ?? this.kernels.none,
            kernelWeight:   this.kernelWeights[filterType]   ?? 0,
            kernelStrength: this.kernelStrengths[filterType] ?? 1.0,
          },
          [sourceImageData.data.buffer]   // transfer — no copy
        )
      );

      if (!result?.rgbaBuffer) return null;

      // ── 5. Wrap result in ImageData, store in cache ───────────────────────
      const rgba      = new Uint8ClampedArray(result.rgbaBuffer);
      const imageData = new ImageData(rgba, cw, ch);
      this._vtkCacheSet(cacheKey, imageData);

      return imageData;
    } catch (err) {
      console.error('[ImageFilterService] applyFilterVTK error:', err);
      return null;
    }
  }

  /**
   * Set filter for a viewport
   */
  public setFilter(viewportId: string, filterType: FilterType): void {
    if (!this.filterState[viewportId]) {
      this.filterState[viewportId] = { filterType };
    } else {
      this.filterState[viewportId].filterType = filterType;
    }

    this._broadcastEvent(EVENTS.FILTER_CHANGED, { viewportId, filterType });
  }

  /**
   * Get current filter for a viewport
   */
  public getFilter(viewportId: string): FilterType {
    return this.filterState[viewportId]?.filterType || 'none';
  }

  /**
   * Clear filter for a viewport
   */
  public clearFilter(viewportId: string): void {
    this.setFilter(viewportId, 'none');
  }

  /**
   * Clean up WebGL resources for a viewport
   */
  public dispose(viewportId: string): void {
    const state = this.filterState[viewportId];
    if (state) {
      const { gl, program, texture } = state;
      if (gl && program) {
        gl.deleteProgram(program);
      }
      if (gl && texture) {
        gl.deleteTexture(texture);
      }
      delete this.filterState[viewportId];
    }
  }

  /**
   * Clean up all resources
   */
  public disposeAll(): void {
    Object.keys(this.filterState).forEach(viewportId => {
      this.dispose(viewportId);
    });
    // Terminate VTK worker and clear cache
    if (this._vtkWorkerInstance) {
      this._vtkWorkerInstance.terminate();
      this._vtkWorkerInstance = null;
      this._vtkProxy = null;
    }
    this._vtkCache.clear();
  }
}

export default ImageFilterService;
export { EVENTS as IMAGE_FILTER_EVENTS };
