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
    activeFilters: FilterType[];
    native: NativeFilterSettings;
  };
}

const EVENTS = {
  FILTER_CHANGED: 'event::imageFilterService:filterChanged',
};

const OHIF_EMBOSSING_KEY = '__ohifEmbossing';
const OHIF_EDGE_KEY = '__ohifEdgeEnhancement';
const OHIF_FILTER_STACK_KEY = '__ohifFilterStack';
const OHIF_SHARPENING_KEY = '__ohifSharpening';
const OHIF_SMOOTHING_KEY = '__ohifSmoothing';
const OHIF_FILTER_PATCHED_KEY = '__ohifFilterPassPatched';

function clampIntensity(value: number): number {
  return Math.max(0, Math.min(3, value));
}

function createGaussianKernel(size: number, sigma: number): number[] {
  const kernel: number[] = [];
  const mean = (size - 1) / 2;
  let sum = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - mean;
      const dy = y - mean;
      const value = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      kernel.push(value);
      sum += value;
    }
  }

  return kernel.map(v => v / sum);
}

function wrapConvolutionPass(delegatePass: any, kernelDimension: number, kernel: number[]) {
  const convolutionPass = vtkConvolution2DPass.newInstance();
  convolutionPass.setDelegates([delegatePass]);
  convolutionPass.setKernelDimension(kernelDimension);
  convolutionPass.setKernel(kernel);
  return convolutionPass;
}

function buildStackedFilterPass(
  stack: FilterType[],
  intensities: {
    sharpening: number;
    smoothing: number;
    embossing: number;
    edgeEnhancement: number;
  }
) {
  let passChain: any = vtkForwardPass.newInstance();
  let hasAnyFilter = false;

  for (const filterType of stack) {
    if (filterType === 'sharpen' && intensities.sharpening > 0) {
      const k = clampIntensity(intensities.sharpening);
      const kernel = [-k, -k, -k, -k, 1 + 8 * k, -k, -k, -k, -k];
      passChain = wrapConvolutionPass(passChain, 3, kernel);
      hasAnyFilter = true;
      continue;
    }

    if (filterType === 'blur' && intensities.smoothing > 0) {
      const smoothStrength = Math.min(clampIntensity(intensities.smoothing), 1000);
      const kernelSize = 15;
      const sigma = 5;
      const gaussianKernel = createGaussianKernel(kernelSize, sigma);
      const totalElements = kernelSize * kernelSize;
      const centerIndex = Math.floor(totalElements / 2);
      const identityKernel = Array(totalElements).fill(0);
      identityKernel[centerIndex] = 1;
      const alpha = Math.min(smoothStrength / 10, 1);
      const kernel = gaussianKernel.map((g, i) => (1 - alpha) * identityKernel[i] + alpha * g);
      passChain = wrapConvolutionPass(passChain, kernelSize, kernel);
      hasAnyFilter = true;
      continue;
    }

    if (filterType === 'emboss' && intensities.embossing > 0) {
      const k = clampIntensity(intensities.embossing);
      const baseKernel = [-2, -1, 0, -1, 1, 1, 0, 1, 2];
      const kernel = baseKernel.map(v => v * k);
      kernel[4] += 1;
      passChain = wrapConvolutionPass(passChain, 3, kernel);
      hasAnyFilter = true;
      continue;
    }

    if (filterType === 'edges' && intensities.edgeEnhancement > 0) {
      const k = clampIntensity(intensities.edgeEnhancement);
      const baseKernel = [-1, -1, -1, -1, 8, -1, -1, -1, -1];
      const kernel = baseKernel.map(v => v * k);
      kernel[4] += 1;
      passChain = wrapConvolutionPass(passChain, 3, kernel);
      hasAnyFilter = true;
    }
  }

  return hasAnyFilter ? passChain : null;
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
    sharpening: 1.6,
    smoothing: 1.6,
    embossing: 1.8,
    edgeEnhancement: 1.8,
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
      activeFilters: [],
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
    this.applyNativeViewportFilters(viewportId, current.activeFilters);
  }

  /**
   * Add a filter layer to the stack.
   * Special case: 'none' clears all filters.
   */
  public toggleFilter(viewportId: string, filterType: FilterType): void {
    const current = this.filterState[viewportId] || {
      activeFilters: [],
      native: { ...ImageFilterService.DEFAULT_NATIVE },
    };

    const activeFilters =
      filterType === 'none' ? [] : [...current.activeFilters, filterType];

    this.filterState[viewportId] = {
      activeFilters,
      native: current.native,
    };

    this.applyNativeViewportFilters(viewportId, activeFilters);
    this._broadcastEvent(EVENTS.FILTER_CHANGED, { viewportId, activeFilters });
  }

  public getActiveFilters(viewportId: string): FilterType[] {
    return this.filterState[viewportId]?.activeFilters || [];
  }

  public removeFilterAt(viewportId: string, index: number): void {
    const current = this.filterState[viewportId] || {
      activeFilters: [],
      native: { ...ImageFilterService.DEFAULT_NATIVE },
    };

    if (index < 0 || index >= current.activeFilters.length) {
      return;
    }

    const activeFilters = [...current.activeFilters];
    activeFilters.splice(index, 1);

    this.filterState[viewportId] = {
      activeFilters,
      native: current.native,
    };

    this.applyNativeViewportFilters(viewportId, activeFilters);
    this._broadcastEvent(EVENTS.FILTER_CHANGED, { viewportId, activeFilters });
  }

  /**
   * Legacy method: replaces all filters with a single one.
   */
  public setFilter(viewportId: string, filterType: FilterType): void {
    const current = this.filterState[viewportId] || {
      activeFilters: [],
      native: { ...ImageFilterService.DEFAULT_NATIVE },
    };

    const activeFilters = filterType === 'none' ? [] : [filterType];

    this.filterState[viewportId] = {
      activeFilters,
      native: current.native,
    };

    this.applyNativeViewportFilters(viewportId, activeFilters);
    this._broadcastEvent(EVENTS.FILTER_CHANGED, { viewportId, activeFilters });
  }

  /**
   * Legacy method: get the first active filter, or 'none'.
   */
  public getFilter(viewportId: string): FilterType {
    const activeFilters = this.getActiveFilters(viewportId);
    return activeFilters.length > 0 ? activeFilters[0] : 'none';
  }

  public clearFilter(viewportId: string): void {
    this.setFilter(viewportId, 'none');
  }

  public clearAllFilters(viewportId: string): void {
    this.toggleFilter(viewportId, 'none');
  }

  public dispose(viewportId: string): void {
    this.clearAllFilters(viewportId);
    delete this.filterState[viewportId];
  }

  public disposeAll(): void {
    Object.keys(this.filterState).forEach(viewportId => {
      this.clearAllFilters(viewportId);
    });
    this.filterState = {};
  }

  private applyNativeViewportFilters(viewportId: string, activeFilters: FilterType[]): void {
    const { cornerstoneViewportService } = this.servicesManager.services as any;
    const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(viewportId);

    if (!viewport?.setProperties) {
      return;
    }

    this.patchViewportForNativeFilters(viewport);

    const native = this.getNativeFilterSettings(viewportId);

    try {
      viewport.setProperties({
        // Keep native sharpening/smoothing disabled; we apply explicit stacked passes below.
        sharpening: 0,
        smoothing: 0,
        embossing: native.embossing,
        edgeEnhancement: native.edgeEnhancement,
        ohifFilterStack: activeFilters,
        ohifSharpening: native.sharpening,
        ohifSmoothing: native.smoothing,
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
      const {
        embossing,
        edgeEnhancement,
        ohifFilterStack,
        ohifSharpening,
        ohifSmoothing,
        ...coreProperties
      } = properties || {};

      if (typeof embossing === 'number') {
        this[OHIF_EMBOSSING_KEY] = clampIntensity(embossing);
      }

      if (typeof edgeEnhancement === 'number') {
        this[OHIF_EDGE_KEY] = clampIntensity(edgeEnhancement);
      }

      if (Array.isArray(ohifFilterStack)) {
        this[OHIF_FILTER_STACK_KEY] = ohifFilterStack.filter((v: any) => v !== 'none');
      }

      if (typeof ohifSharpening === 'number') {
        this[OHIF_SHARPENING_KEY] = clampIntensity(ohifSharpening);
      }

      if (typeof ohifSmoothing === 'number') {
        this[OHIF_SMOOTHING_KEY] = clampIntensity(ohifSmoothing);
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
        ohifFilterStack: this[OHIF_FILTER_STACK_KEY] || [],
      };
    };

    viewport.getRenderPasses = function (...args: any[]) {
      const basePasses = originalGetRenderPasses.call(this, ...args);
      const renderPasses = Array.isArray(basePasses) ? [...basePasses] : [];

      try {
        const embossing = clampIntensity(this[OHIF_EMBOSSING_KEY] || 0);
        const edgeEnhancement = clampIntensity(this[OHIF_EDGE_KEY] || 0);
        const sharpening = clampIntensity(this[OHIF_SHARPENING_KEY] || 0);
        const smoothing = clampIntensity(this[OHIF_SMOOTHING_KEY] || 0);
        const stack = Array.isArray(this[OHIF_FILTER_STACK_KEY]) ? this[OHIF_FILTER_STACK_KEY] : [];
        const stackedPass = buildStackedFilterPass(stack, {
          sharpening,
          smoothing,
          embossing,
          edgeEnhancement,
        });

        if (stackedPass) {
          renderPasses.push(stackedPass);
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
