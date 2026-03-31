import { PubSubService } from '@ohif/core';
import { Types as OhifTypes } from '@ohif/core';
import vtkConvolution2DPass from '@kitware/vtk.js/Rendering/OpenGL/Convolution2DPass';
import vtkForwardPass from '@kitware/vtk.js/Rendering/OpenGL/ForwardPass';

export type FilterType = 'none' | 'sharpen' | 'blur' | 'emboss' | 'edges';

type NativeFilterSettings = {
  sharpening: number;
  smoothing: number;
  embossing: number;
  edgeEnhancement: number;
};

interface FilterState {
  [viewportId: string]: {
    filterType: FilterType;
    native: NativeFilterSettings;
  };
}

const EVENTS = {
  FILTER_CHANGED: 'event::imageFilterService:filterChanged',
};

const OHIF_EMBOSSING_KEY = '__ohifEmbossing';
const OHIF_EDGE_KEY = '__ohifEdgeEnhancement';
const OHIF_FILTER_PATCHED_KEY = '__ohifFilterPassPatched';

function clampIntensity(value: number): number {
  return Math.max(0, Math.min(3, value));
}

function createEmbossRenderPass(intensity: number) {
  let renderPass = vtkForwardPass.newInstance();

  if (intensity > 0) {
    const convolutionPass = vtkConvolution2DPass.newInstance();
    convolutionPass.setDelegates([renderPass]);

    const k = clampIntensity(intensity);
    const baseKernel = [-2, -1, 0, -1, 1, 1, 0, 1, 2];
    const kernel = baseKernel.map(v => v * k);
    kernel[4] += 1;

    convolutionPass.setKernelDimension(3);
    convolutionPass.setKernel(kernel);
    renderPass = convolutionPass;
  }

  return renderPass;
}

function createEdgeRenderPass(intensity: number) {
  let renderPass = vtkForwardPass.newInstance();

  if (intensity > 0) {
    const convolutionPass = vtkConvolution2DPass.newInstance();
    convolutionPass.setDelegates([renderPass]);

    const k = clampIntensity(intensity);
    const baseKernel = [-1, -1, -1, -1, 8, -1, -1, -1, -1];
    const kernel = baseKernel.map(v => v * k);
    kernel[4] += 1;

    convolutionPass.setKernelDimension(3);
    convolutionPass.setKernel(kernel);
    renderPass = convolutionPass;
  }

  return renderPass;
}

/**
 * Native image-filter service:
 * - Uses Cornerstone's render-pass pipeline for sharpen/blur.
 * - Extends the same pattern for emboss/edges by patching viewport prototypes.
 * - No canvas post-processing, no worker pipeline.
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

  private static readonly DEFAULT_NATIVE: NativeFilterSettings = {
    sharpening: 0.5,
    smoothing: 1,
    embossing: 1.2,
    edgeEnhancement: 1.2,
  };

  constructor(servicesManager: AppTypes.ServicesManager) {
    super(EVENTS);
    this.servicesManager = servicesManager;
  }

  public getNativeFilterSettings(viewportId: string): NativeFilterSettings {
    const state = this.filterState[viewportId];
    return {
      ...ImageFilterService.DEFAULT_NATIVE,
      ...(state?.native || {}),
    };
  }

  public setNativeFilterSettings(
    viewportId: string,
    settings: Partial<NativeFilterSettings>
  ): void {
    const current = this.filterState[viewportId] || {
      filterType: 'none' as FilterType,
      native: { ...ImageFilterService.DEFAULT_NATIVE },
    };

    current.native = {
      ...current.native,
      ...(typeof settings.sharpening === 'number'
        ? { sharpening: clampIntensity(settings.sharpening) }
        : {}),
      ...(typeof settings.smoothing === 'number'
        ? { smoothing: clampIntensity(settings.smoothing) }
        : {}),
      ...(typeof settings.embossing === 'number'
        ? { embossing: clampIntensity(settings.embossing) }
        : {}),
      ...(typeof settings.edgeEnhancement === 'number'
        ? { edgeEnhancement: clampIntensity(settings.edgeEnhancement) }
        : {}),
    };

    this.filterState[viewportId] = current;
    this.applyNativeViewportFilters(viewportId, current.filterType);
  }

  public setFilter(viewportId: string, filterType: FilterType): void {
    const previous = this.filterState[viewportId];

    this.filterState[viewportId] = {
      filterType,
      native: previous?.native || { ...ImageFilterService.DEFAULT_NATIVE },
    };

    this.applyNativeViewportFilters(viewportId, filterType);
    this._broadcastEvent(EVENTS.FILTER_CHANGED, { viewportId, filterType });
  }

  public getFilter(viewportId: string): FilterType {
    return this.filterState[viewportId]?.filterType || 'none';
  }

  public clearFilter(viewportId: string): void {
    this.setFilter(viewportId, 'none');
  }

  public dispose(viewportId: string): void {
    this.setFilter(viewportId, 'none');
    delete this.filterState[viewportId];
  }

  public disposeAll(): void {
    Object.keys(this.filterState).forEach(viewportId => {
      this.setFilter(viewportId, 'none');
    });
    this.filterState = {};
  }

  private applyNativeViewportFilters(viewportId: string, filterType: FilterType): void {
    const { cornerstoneViewportService } = this.servicesManager.services as any;
    const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(viewportId);

    if (!viewport?.setProperties) {
      return;
    }

    this.patchViewportForNativeFilters(viewport);

    const native = this.getNativeFilterSettings(viewportId);

    const sharpening = filterType === 'sharpen' ? native.sharpening : 0;
    const smoothing = filterType === 'blur' ? native.smoothing : 0;
    const embossing = filterType === 'emboss' ? native.embossing : 0;
    const edgeEnhancement = filterType === 'edges' ? native.edgeEnhancement : 0;

    try {
      viewport.setProperties({
        sharpening,
        smoothing,
        embossing,
        edgeEnhancement,
      });
      viewport.render?.();
    } catch {
      // Ignore unsupported viewport/property combinations.
    }
  }

  private patchViewportForNativeFilters(viewport: any): void {
    if (!viewport || viewport[OHIF_FILTER_PATCHED_KEY]) {
      return;
    }

    const originalSetProperties = viewport.setProperties;
    const originalGetProperties = viewport.getProperties;
    const originalGetRenderPasses = viewport.getRenderPasses;

    if (typeof originalSetProperties !== 'function' || typeof originalGetRenderPasses !== 'function') {
      return;
    }

    viewport.setProperties = function (properties: any = {}, ...rest: any[]) {
      const { embossing, edgeEnhancement, ...coreProperties } = properties || {};

      if (typeof embossing === 'number') {
        this[OHIF_EMBOSSING_KEY] = clampIntensity(embossing);
      }

      if (typeof edgeEnhancement === 'number') {
        this[OHIF_EDGE_KEY] = clampIntensity(edgeEnhancement);
      }

      return originalSetProperties.call(this, coreProperties, ...rest);
    };

    viewport.getProperties = function (...args: any[]) {
      const original =
        typeof originalGetProperties === 'function'
          ? originalGetProperties.call(this, ...args)
          : {};

      if (!original || typeof original !== 'object') {
        return original;
      }

      return {
        ...original,
        embossing: this[OHIF_EMBOSSING_KEY] || 0,
        edgeEnhancement: this[OHIF_EDGE_KEY] || 0,
      };
    };

    viewport.getRenderPasses = function (...args: any[]) {
      const basePasses = originalGetRenderPasses.call(this, ...args);
      const renderPasses = Array.isArray(basePasses) ? [...basePasses] : [];

      try {
        const embossing = clampIntensity(this[OHIF_EMBOSSING_KEY] || 0);
        const edgeEnhancement = clampIntensity(this[OHIF_EDGE_KEY] || 0);

        if (embossing > 0) {
          renderPasses.push(createEmbossRenderPass(embossing));
        }

        if (edgeEnhancement > 0) {
          renderPasses.push(createEdgeRenderPass(edgeEnhancement));
        }
      } catch {
        // Keep base passes if custom pass creation fails.
      }

      return renderPasses.length ? renderPasses : null;
    };

    viewport[OHIF_FILTER_PATCHED_KEY] = true;
  }
}

export default ImageFilterService;
export { EVENTS as IMAGE_FILTER_EVENTS };
