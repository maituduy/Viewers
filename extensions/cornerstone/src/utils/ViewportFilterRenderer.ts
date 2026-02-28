import { Enums, getEnabledElement, StackViewport } from '@cornerstonejs/core';
import { FilterType } from '../services/ImageFilterService';

/**
 * Applies image filters to Cornerstone viewport canvas.
 * Writes filtered result directly into the source canvas synchronously inside
 * IMAGE_RENDERED — which fires before the browser paints, so no flash occurs
 * and no overlay canvas is needed (avoiding z-index conflicts with UI elements).
 */
export class ViewportFilterRenderer {
  private imageFilterService: any;
  private eventListeners: Map<string, { event: string; handler: Function }[]> = new Map();

  constructor(imageFilterService: any) {
    this.imageFilterService = imageFilterService;
  }

  /**
   * Enable filter rendering for a viewport
   */
  public enableFilterRendering(viewportId: string, element: HTMLElement): void {
    if (!this.imageFilterService) {
      return;
    }

    // Listen to Cornerstone render events
    const renderHandler = (evt: any) => {
      const { element: renderElement } = evt.detail;
      if (renderElement !== element) {
        return;
      }

      this.applyFilterToCanvas(viewportId, element);
    };

    // Only listen to IMAGE_RENDERED - the final event after full render complete
    const events = [Enums.Events.IMAGE_RENDERED];

    const listeners = events.map(event => ({ event, handler: renderHandler }));
    this.eventListeners.set(viewportId, listeners);

    events.forEach(event => {
      element.addEventListener(event, renderHandler as EventListener);
    });
  }

  public disableFilterRendering(viewportId: string, element: HTMLElement): void {
    const listeners = this.eventListeners.get(viewportId);
    if (listeners) {
      listeners.forEach(({ event, handler }) => {
        element.removeEventListener(event, handler as EventListener);
      });
      this.eventListeners.delete(viewportId);
    }

    if (this.imageFilterService) {
      this.imageFilterService.dispose(viewportId);
    }
  }

  /**
   * Apply filter directly into the source canvas.
   * IMAGE_RENDERED fires before browser paint → no flash, no overlay needed.
   *
   * Priority:
   *   1. StackViewport: 16-bit CPU path — convolution on raw HU BEFORE VOI/LUT
   *   2. Fallback: 8-bit WebGL path — convolution on displayed 8-bit canvas
   */
  private applyFilterToCanvas(viewportId: string, element: HTMLElement): void {
    try {
      if (!this.imageFilterService) {
        return;
      }

      const filterType = this.imageFilterService.getFilter(viewportId);
      if (filterType === 'none') {
        return;
      }

      const canvas = element.querySelector('canvas') as HTMLCanvasElement;
      if (!canvas || !canvas.width || !canvas.height) {
        return;
      }

      // ── Path 1: 16-bit CPU (StackViewport only) — disabled for comparison ──
      // Uncomment to re-enable 16-bit precision pipeline:
      // const enabledElement = getEnabledElement(element);
      // if (enabledElement?.viewport instanceof StackViewport) {
      //   const imageData = this.imageFilterService.applyFilter16bit(
      //     viewportId,
      //     enabledElement.viewport,
      //     canvas,
      //     filterType
      //   );
      //   if (imageData) {
      //     const ctx = canvas.getContext('2d');
      //     if (ctx) ctx.putImageData(imageData, 0, 0);
      //     return;
      //   }
      // }

      // ── Path 2: 8-bit WebGL ───────────────────────────────────────────────
      const filteredCanvas = this.imageFilterService.applyFilter(viewportId, canvas, filterType);
      if (filteredCanvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.drawImage(filteredCanvas, 0, 0);
      }
    } catch (error) {
      console.warn('Error in applyFilterToCanvas:', error);
    }
  }

  public dispose(): void {
    this.eventListeners.clear();
  }
}

export default ViewportFilterRenderer;
