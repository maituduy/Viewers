import { Enums, getEnabledElement, StackViewport } from '@cornerstonejs/core';
import { FilterType } from '../services/ImageFilterService';

/**
 * Applies image filters to Cornerstone viewport canvas.
 *
 * Three rendering paths, in priority order:
 *
 *   Path A — VTK Worker (StackViewport, 16-bit HU, async):
 *     Convolution on raw HU data in a WebWorker → precision without UI jank.
 *     Results are cached in ImageFilterService._vtkCache.
 *     First render: falls back to Path B while worker computes, then triggers
 *     a re-render to show the high-quality result.
 *
 *   Path B — 8-bit WebGL (instant synchronous fallback):
 *     Used while Path A is computing on first render, or for VolumeViewports.
 *
 *   Path C — (commented out) inline CPU 16-bit, kept for reference.
 *
 * Writes results directly into the source canvas inside IMAGE_RENDERED, which
 * fires before the browser paints → no flash, no overlay canvas needed.
 */
export class ViewportFilterRenderer {
  private imageFilterService: any;
  private eventListeners: Map<string, { event: string; handler: Function }[]> = new Map();
  /** viewportId → true if a VTK worker job is currently in flight */
  private _vtkPending: Set<string> = new Set();

  constructor(imageFilterService: any) {
    this.imageFilterService = imageFilterService;
  }

  public enableFilterRendering(viewportId: string, element: HTMLElement): void {
    if (!this.imageFilterService) return;

    const renderHandler = (evt: any) => {
      const { element: renderElement } = evt.detail;
      if (renderElement !== element) return;
      this.applyFilterToCanvas(viewportId, element);
    };

    const events = [Enums.Events.IMAGE_RENDERED];
    const listeners = events.map(event => ({ event, handler: renderHandler }));
    this.eventListeners.set(viewportId, listeners);
    events.forEach(event => element.addEventListener(event, renderHandler as EventListener));
  }

  public disableFilterRendering(viewportId: string, element: HTMLElement): void {
    const listeners = this.eventListeners.get(viewportId);
    if (listeners) {
      listeners.forEach(({ event, handler }) =>
        element.removeEventListener(event, handler as EventListener)
      );
      this.eventListeners.delete(viewportId);
    }
    this._vtkPending.delete(viewportId);
    if (this.imageFilterService) this.imageFilterService.dispose(viewportId);
  }

  /**
   * Core rendering handler. Runs synchronously inside IMAGE_RENDERED.
   *
   * For StackViewports:
   *   1. Sync cache hit  → putImageData immediately (before browser paint). Fast path.
   *   2. Cache miss      → apply 8-bit WebGL instantly as placeholder,
   *                        kick off VTK worker in background,
   *                        trigger one re-render when result arrives (goes to step 1).
   */
  private applyFilterToCanvas(viewportId: string, element: HTMLElement): void {
    try {
      if (!this.imageFilterService) return;

      const filterType = this.imageFilterService.getFilter(viewportId);
      if (filterType === 'none') return;

      const vtkEnabled = this.imageFilterService.isVTKFilterEnabled?.() ?? true;

      const canvas = element.querySelector('canvas') as HTMLCanvasElement;
      if (!canvas || !canvas.width || !canvas.height) return;

      // Global override: disable VTK and force WebGL path.
      if (!vtkEnabled) {
        this._applyWebGL(viewportId, canvas, filterType);
        return;
      }

      // ── Path A: VTK Worker (StackViewport only) ─────────────────────────
      const enabledElement = getEnabledElement(element);
      if (enabledElement?.viewport instanceof StackViewport) {
        const viewport = enabledElement.viewport;

        // Step A1: check cache synchronously — paint before browser paint if ready
        const cached = this.imageFilterService.peekVTKCache(
          viewportId, viewport, canvas, filterType
        );
        if (cached) {
          const ctx = canvas.getContext('2d');
          if (ctx) ctx.putImageData(cached, 0, 0);
          return;
        }

        // Step A2: cache miss — show 8-bit WebGL immediately as placeholder
        this._applyWebGL(viewportId, canvas, filterType);

        // Step A3: kick off VTK worker (only one job per viewport at a time)
        if (!this._vtkPending.has(viewportId)) {
          this._vtkPending.add(viewportId);
          this.imageFilterService
            .applyFilterVTK(viewportId, viewport, canvas, filterType)
            .then((imageData: ImageData | null) => {
              this._vtkPending.delete(viewportId);
              if (imageData) {
                // One re-render: next IMAGE_RENDERED will hit cache (Step A1)
                try { viewport.render(); } catch (_) { /* viewport unmounted */ }
              }
            })
            .catch(() => this._vtkPending.delete(viewportId));
        }
        return;
      }

      // ── Path B: 8-bit WebGL (VolumeViewport or fallback) ────────────────
      this._applyWebGL(viewportId, canvas, filterType);
    } catch (error) {
      console.warn('[ViewportFilterRenderer] applyFilterToCanvas error:', error);
    }
  }

  /** Apply the fast WebGL 8-bit filter path. */
  private _applyWebGL(viewportId: string, canvas: HTMLCanvasElement, filterType: FilterType): void {
    const filteredCanvas = this.imageFilterService.applyFilter(viewportId, canvas, filterType);
    if (filteredCanvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(filteredCanvas, 0, 0);
    }
  }

  public dispose(): void {
    this.eventListeners.clear();
    this._vtkPending.clear();
  }
}

export default ViewportFilterRenderer;
