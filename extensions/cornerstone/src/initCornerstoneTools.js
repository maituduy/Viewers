import {
  PanTool,
  WindowLevelTool,
  SegmentBidirectionalTool,
  StackScrollTool,
  VolumeRotateTool,
  ZoomTool,
  MIPJumpToClickTool,
  LengthTool,
  RectangleROITool,
  RectangleROIThresholdTool,
  EllipticalROITool,
  CircleROITool,
  BidirectionalTool,
  ArrowAnnotateTool,
  DragProbeTool,
  ProbeTool,
  AngleTool,
  CobbAngleTool,
  MagnifyTool,
  CrosshairsTool,
  RectangleScissorsTool,
  SphereScissorsTool,
  CircleScissorsTool,
  BrushTool,
  PaintFillTool,
  init,
  addTool,
  annotation,
  ReferenceLinesTool,
  TrackballRotateTool,
  AdvancedMagnifyTool,
  UltrasoundDirectionalTool,
  UltrasoundPleuraBLineTool,
  PlanarFreehandROITool,
  PlanarFreehandContourSegmentationTool,
  SplineROITool,
  LivewireContourTool,
  OrientationMarkerTool,
  WindowLevelRegionTool,
  SegmentSelectTool,
  RegionSegmentPlusTool,
  SegmentLabelTool,
  LivewireContourSegmentationTool,
  SculptorTool,
  SplineContourSegmentationTool,
  LabelMapEditWithContourTool,
} from '@cornerstonejs/tools';
import { Enums as csEnums, utilities as csUtils, cache as csCache } from '@cornerstonejs/core';
import { LabelmapSlicePropagationTool, MarkerLabelmapTool } from '@cornerstonejs/ai';
import * as polySeg from '@cornerstonejs/polymorphic-segmentation';

import CalibrationLineTool from './tools/CalibrationLineTool';
import ImageOverlayViewerTool from './tools/ImageOverlayViewerTool';
import OpenSplineTool from './tools/OpenSplineTool';
import AutoVesselTracingTool from './tools/AutoVesselTracingTool';
import { BaseCPRTool } from './tools/BaseCPRTool';

let isWindowLevelTool3DPatched = false;

/** @param {any} servicesManager */
function patchWindowLevelToolFor3D(servicesManager = null) {
  if (isWindowLevelTool3DPatched) {
    return;
  }

  const originalGetNewRange = WindowLevelTool.prototype.getNewRange;
  const WL_3D_DELTA_CLAMP = 24;
  const WL_3D_WW_MULTIPLIER = 2.0;
  const WL_3D_WC_MULTIPLIER = 2.0;
  const WL_3D_DRAG_SCALE = 0.5;
  const WL_3D_WIDE_BASELINE_THRESHOLD = 5000;
  const WL_3D_EMERGENCY_BASELINE_WW = 2000;
  const WL_3D_AUTO_SHIFT_FACTOR = 1.0;
  const WL_3D_AUTO_SHIFT_MAX_DELTA = 30;

  /** @type {(value: number) => number} */
  const clampDelta = value => {
    return Math.max(-WL_3D_DELTA_CLAMP, Math.min(WL_3D_DELTA_CLAMP, value || 0));
  };

  /** @type {(value: any) => number | null} */
  const coerceNumeric = value => {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'string') {
      const firstToken = value.split('\\')[0]?.trim();
      const parsed = Number(firstToken);
      return Number.isFinite(parsed) ? parsed : null;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        const parsed = coerceNumeric(entry);
        if (typeof parsed === 'number') {
          return parsed;
        }
      }
    }

    return null;
  };

  /** @type {(candidate: any) => { windowWidth: number; windowCenter: number } | null} */
  const extractWindowLevel = candidate => {
    if (!candidate) {
      return null;
    }

    const nestedVoi = candidate.voi;
    const nestedWindowLevel = candidate.windowLevel;

    const windowWidth =
      coerceNumeric(candidate.windowWidth) ??
      coerceNumeric(candidate.WindowWidth) ??
      coerceNumeric(candidate.window) ??
      coerceNumeric(nestedWindowLevel?.windowWidth) ??
      coerceNumeric(nestedWindowLevel?.WindowWidth) ??
      coerceNumeric(nestedWindowLevel?.window) ??
      coerceNumeric(nestedVoi?.windowWidth) ??
      coerceNumeric(nestedVoi?.WindowWidth) ??
      coerceNumeric(nestedVoi?.window);

    const windowCenter =
      coerceNumeric(candidate.windowCenter) ??
      coerceNumeric(candidate.WindowCenter) ??
      coerceNumeric(candidate.level) ??
      coerceNumeric(nestedWindowLevel?.windowCenter) ??
      coerceNumeric(nestedWindowLevel?.WindowCenter) ??
      coerceNumeric(nestedWindowLevel?.level) ??
      coerceNumeric(nestedVoi?.windowCenter) ??
      coerceNumeric(nestedVoi?.WindowCenter) ??
      coerceNumeric(nestedVoi?.level);

    if (
      typeof windowWidth === 'number' &&
      windowWidth > 0 &&
      Number.isFinite(windowWidth) &&
      typeof windowCenter === 'number' &&
      Number.isFinite(windowCenter)
    ) {
      return { windowWidth, windowCenter };
    }

    return null;
  };

  /** @type {(viewportId: string | undefined) => { lower: number; upper: number } | null} */
  const getDisplaySetVoiRange = viewportId => {
    if (!viewportId) {
      return null;
    }

    const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;
    const viewportInfo = cornerstoneViewportService?.getViewportInfo?.(viewportId);
    const displaySetOptions = viewportInfo?.getDisplaySetOptions?.();
    const voi = displaySetOptions?.[0]?.voi;

    if (voi && typeof voi.windowWidth === 'number' && typeof voi.windowCenter === 'number') {
      return csUtils.windowLevel.toLowHighRange(voi.windowWidth, voi.windowCenter);
    }

    const displaySetUID = viewportInfo?.getViewportData?.()?.data?.[0]?.displaySetInstanceUID;
    const displaySetService = servicesManager?.services?.displaySetService;
    const displaySet = displaySetUID ? displaySetService?.getDisplaySetByUID?.(displaySetUID) : null;

    const candidates = [
      displaySet,
      displaySet?.instance,
      displaySet?.firstInstance,
      Array.isArray(displaySet?.instances) ? displaySet.instances[0] : null,
      Array.isArray(displaySet?.images) ? displaySet.images[0] : null,
    ];

    for (const candidate of candidates) {
      const wl = extractWindowLevel(candidate);
      if (!wl) {
        continue;
      }
      return csUtils.windowLevel.toLowHighRange(wl.windowWidth, wl.windowCenter);
    }

    return null;
  };

  /** @type {(volumeId: string | undefined) => { lower: number; upper: number } | null} */
  const getPresetVoiRange = volumeId => {
    if (!volumeId) {
      return null;
    }

    const customizationService = servicesManager?.services?.customizationService;
    const presets = customizationService?.getCustomization?.('cornerstone.windowLevelPresets');
    const volume = csCache.getVolume(volumeId);
    const modality = volume?.metadata?.Modality;
    const modalityPresets = modality ? presets?.[modality] : null;
    const firstPreset = modalityPresets ? Object.values(modalityPresets)[0] : null;

    if (
      !firstPreset ||
      typeof firstPreset.window !== 'number' ||
      typeof firstPreset.level !== 'number'
    ) {
      return null;
    }

    return csUtils.windowLevel.toLowHighRange(firstPreset.window, firstPreset.level);
  };

  /** @type {(viewport: any, volumeId: string | undefined) => { lower: number; upper: number } | null} */
  const getViewportStoredBaseline = (viewport, volumeId) => {
    if (!viewport) {
      return null;
    }

    const byVolume = viewport.__ohifWL3DBaselineByVolumeId;
    if (volumeId && byVolume?.[volumeId]) {
      return byVolume[volumeId];
    }

    return viewport.__ohifWL3DFallbackVoiRange || null;
  };

  /** @type {(viewport: any, volumeId: string | undefined) => { lower: number; upper: number } | null} */
  const getActorVoiRange = (viewport, volumeId) => {
    if (!viewport?.getActors || !volumeId) {
      return null;
    }

    const actorEntry = viewport
      .getActors()
      ?.find?.(
        /** @param {any} entry */
        entry => entry?.referencedId === volumeId || entry?.uid === volumeId
      );
    const volumeActor = actorEntry?.actor;
    const cfun = volumeActor?.getProperty?.()?.getRGBTransferFunction?.(0);
    const range = cfun?.getRange?.();

    if (!range || range.length < 2) {
      return null;
    }

    const lower = Number(range[0]);
    const upper = Number(range[1]);
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) {
      return null;
    }

    return { lower, upper };
  };

  /** @type {(viewport: any, shiftDelta: number) => void} */
  const applyAutoOpacityShift = (viewport, shiftDelta) => {
    if (!viewport || !Number.isFinite(shiftDelta) || Math.abs(shiftDelta) < 0.001) {
      return;
    }

    const boundedShift = Math.max(
      -WL_3D_AUTO_SHIFT_MAX_DELTA,
      Math.min(WL_3D_AUTO_SHIFT_MAX_DELTA, shiftDelta)
    );

    const actor = viewport?.getActors?.()?.[0]?.actor;
    const ofun = actor?.getProperty?.()?.getScalarOpacity?.(0);
    if (!ofun) {
      return;
    }

    const size = ofun.getSize?.();
    if (!Number.isFinite(size) || size <= 0) {
      return;
    }

    const opacityPointValues = [];
    for (let pointIdx = 0; pointIdx < size; pointIdx++) {
      const opacityPointValue = [0, 0, 0, 0];
      ofun.getNodeValue(pointIdx, opacityPointValue);
      opacityPointValue[0] += boundedShift;
      opacityPointValues.push(opacityPointValue);
    }

    ofun.removeAllPoints();
    opacityPointValues.forEach(opacityPointValue => {
      ofun.addPoint(...opacityPointValue);
    });

    viewport.shiftedBy = (Number(viewport.shiftedBy) || 0) + boundedShift;
  };

  /** @type {typeof WindowLevelTool.prototype.getNewRange} */
  WindowLevelTool.prototype.getNewRange = function (args) {
    const { viewport, deltaPointsCanvas, volumeId } = args;

    const is3DViewport =
      viewport?.type === csEnums.ViewportType.VOLUME_3D ||
      viewport?.type === csEnums.ViewportType.PERSPECTIVE;

    if (!is3DViewport) {
      return originalGetNewRange.call(this, args);
    }

    // For 3D, always use the viewport's current VOI as the drag baseline.
    // This prevents the first drag frame from jumping to a far-away WW/WC value.
    const effectiveVolumeId =
      volumeId || viewport?.getVolumeId?.() || viewport?.getAllVolumeIds?.()?.[0];

    const currentVoiRange =
      viewport?.getProperties?.(effectiveVolumeId)?.voiRange || viewport?.getProperties?.()?.voiRange;

    let baseLower = typeof currentVoiRange?.lower === 'number' ? currentVoiRange.lower : args.lower;
    let baseUpper = typeof currentVoiRange?.upper === 'number' ? currentVoiRange.upper : args.upper;

    const baseWindowWidth = baseUpper - baseLower;
    const fallbackStoredRange = getViewportStoredBaseline(viewport, effectiveVolumeId);
    const fallbackActorRange = getActorVoiRange(viewport, effectiveVolumeId);
    const fallbackDisplaySetRange = getDisplaySetVoiRange(viewport?.id);
    const fallbackPresetRange = getPresetVoiRange(effectiveVolumeId);
    const fallbackRange =
      fallbackStoredRange || fallbackActorRange || fallbackDisplaySetRange || fallbackPresetRange;
    const fallbackWindowWidth =
      fallbackRange?.upper !== undefined && fallbackRange?.lower !== undefined
        ? fallbackRange.upper - fallbackRange.lower
        : null;

    // Only override a wide baseline when fallback is materially narrower.
    // This avoids "snap back" for legit high-WW studies (e.g. ~5937).
    const isFallbackNarrowRange =
      typeof fallbackWindowWidth === 'number' && fallbackWindowWidth <= WL_3D_WIDE_BASELINE_THRESHOLD;

    const shouldOverrideWideBaseline =
      baseWindowWidth > WL_3D_WIDE_BASELINE_THRESHOLD &&
      isFallbackNarrowRange &&
      fallbackWindowWidth < baseWindowWidth - 200;

    if (shouldOverrideWideBaseline && fallbackRange) {
      baseLower = fallbackRange.lower;
      baseUpper = fallbackRange.upper;
    }

    // Last-resort guard: if 3D baseline is still full-range and we have no fallback,
    // clamp to a practical WW so first drag doesn't jump around 6000+.
    if (baseWindowWidth > WL_3D_WIDE_BASELINE_THRESHOLD && !fallbackRange) {
      const baseCenter = baseLower + baseWindowWidth / 2;
      const emergencyHalf = WL_3D_EMERGENCY_BASELINE_WW / 2;
      baseLower = baseCenter - emergencyHalf;
      baseUpper = baseCenter + emergencyHalf;
    }

    let { windowWidth, windowCenter } = csUtils.windowLevel.toWindowLevel(baseLower, baseUpper);

    const deltaX = clampDelta(deltaPointsCanvas?.[0]);
    const deltaY = clampDelta(deltaPointsCanvas?.[1]);

    windowWidth = Math.max(1, windowWidth + deltaX * WL_3D_WW_MULTIPLIER * WL_3D_DRAG_SCALE);
    windowCenter = windowCenter + deltaY * WL_3D_WC_MULTIPLIER * WL_3D_DRAG_SCALE;

    const voiLutFunction = viewport?.getProperties?.()?.VOILUTFunction;
    const nextRange = csUtils.windowLevel.toLowHighRange(windowWidth, windowCenter, voiLutFunction);

    const baseWindowCenter = baseLower + (baseUpper - baseLower) / 2;
    const nextWindowCenter = nextRange.lower + (nextRange.upper - nextRange.lower) / 2;
    applyAutoOpacityShift(viewport, (nextWindowCenter - baseWindowCenter) * WL_3D_AUTO_SHIFT_FACTOR);

    // Keep the runtime baseline in sync with the latest drag result to prevent stale fallback snap-back.
    if (nextRange?.lower !== undefined && nextRange?.upper !== undefined) {
      const vp = viewport;
      vp.__ohifWL3DBaselineByVolumeId = vp.__ohifWL3DBaselineByVolumeId || {};
      if (effectiveVolumeId) {
        vp.__ohifWL3DBaselineByVolumeId[effectiveVolumeId] = {
          lower: nextRange.lower,
          upper: nextRange.upper,
        };
      }

      vp.__ohifWL3DFallbackVoiRange = {
        lower: nextRange.lower,
        upper: nextRange.upper,
      };
    }

    return nextRange;
  };

  isWindowLevelTool3DPatched = true;
}

export default function initCornerstoneTools(configuration = {}, servicesManager = null) {
  patchWindowLevelToolFor3D(servicesManager);

  CrosshairsTool.isAnnotation = false;
  LabelmapSlicePropagationTool.isAnnotation = false;
  MarkerLabelmapTool.isAnnotation = false;
  ReferenceLinesTool.isAnnotation = false;
  AdvancedMagnifyTool.isAnnotation = false;
  PlanarFreehandContourSegmentationTool.isAnnotation = false;

  init({
    addons: {
      polySeg,
    },
    computeWorker: {
      autoTerminateOnIdle: {
        enabled: false,
      },
    },
  });
  addTool(PanTool);
  addTool(SegmentBidirectionalTool);
  addTool(WindowLevelTool);
  addTool(StackScrollTool);
  addTool(VolumeRotateTool);
  addTool(ZoomTool);
  addTool(ProbeTool);
  addTool(MIPJumpToClickTool);
  addTool(LengthTool);
  addTool(RectangleROITool);
  addTool(RectangleROIThresholdTool);
  addTool(EllipticalROITool);
  addTool(CircleROITool);
  addTool(BidirectionalTool);
  addTool(ArrowAnnotateTool);
  addTool(DragProbeTool);
  addTool(AngleTool);
  addTool(CobbAngleTool);
  addTool(MagnifyTool);
  addTool(CrosshairsTool);
  addTool(RectangleScissorsTool);
  addTool(SphereScissorsTool);
  addTool(CircleScissorsTool);
  addTool(BrushTool);
  addTool(PaintFillTool);
  addTool(ReferenceLinesTool);
  addTool(OpenSplineTool);
  addTool(AutoVesselTracingTool);
  addTool(CalibrationLineTool);
  addTool(TrackballRotateTool);
  addTool(ImageOverlayViewerTool);
  addTool(AdvancedMagnifyTool);
  addTool(UltrasoundDirectionalTool);
  addTool(UltrasoundPleuraBLineTool);
  addTool(PlanarFreehandROITool);
  addTool(SplineROITool);
  addTool(LivewireContourTool);
  addTool(OrientationMarkerTool);
  addTool(WindowLevelRegionTool);
  addTool(PlanarFreehandContourSegmentationTool);
  addTool(SegmentSelectTool);
  addTool(SegmentLabelTool);
  addTool(LabelmapSlicePropagationTool);
  addTool(MarkerLabelmapTool);
  addTool(RegionSegmentPlusTool);
  addTool(LivewireContourSegmentationTool);
  addTool(SculptorTool);
  addTool(SplineContourSegmentationTool);
  addTool(LabelMapEditWithContourTool);

  // Initialize hanging protocol listener for CPR cleanup
  if (servicesManager) {
    BaseCPRTool.initializeHPListener(servicesManager);
  }

  // Modify annotation tools to use dashed lines on SR
  const annotationStyle = {
    textBoxFontSize: '15px',
    lineWidth: '1.5',
  };

  const defaultStyles = annotation.config.style.getDefaultToolStyles();
  annotation.config.style.setDefaultToolStyles({
    global: {
      ...defaultStyles.global,
      ...annotationStyle,
    },
  });
}

const toolNames = {
  Pan: PanTool.toolName,
  ArrowAnnotate: ArrowAnnotateTool.toolName,
  WindowLevel: WindowLevelTool.toolName,
  StackScroll: StackScrollTool.toolName,
  Zoom: ZoomTool.toolName,
  VolumeRotate: VolumeRotateTool.toolName,
  MipJumpToClick: MIPJumpToClickTool.toolName,
  Length: LengthTool.toolName,
  DragProbe: DragProbeTool.toolName,
  Probe: ProbeTool.toolName,
  RectangleROI: RectangleROITool.toolName,
  RectangleROIThreshold: RectangleROIThresholdTool.toolName,
  EllipticalROI: EllipticalROITool.toolName,
  CircleROI: CircleROITool.toolName,
  Bidirectional: BidirectionalTool.toolName,
  Angle: AngleTool.toolName,
  CobbAngle: CobbAngleTool.toolName,
  Magnify: MagnifyTool.toolName,
  Crosshairs: CrosshairsTool.toolName,
  Brush: BrushTool.toolName,
  PaintFill: PaintFillTool.toolName,
  ReferenceLines: ReferenceLinesTool.toolName,
  CalibrationLine: CalibrationLineTool.toolName,
  OpenSpline: OpenSplineTool.toolName,
  AutoVesselTracing: AutoVesselTracingTool.toolName,
  TrackballRotateTool: TrackballRotateTool.toolName,
  CircleScissors: CircleScissorsTool.toolName,
  RectangleScissors: RectangleScissorsTool.toolName,
  SphereScissors: SphereScissorsTool.toolName,
  ImageOverlayViewer: ImageOverlayViewerTool.toolName,
  AdvancedMagnify: AdvancedMagnifyTool.toolName,
  UltrasoundDirectional: UltrasoundDirectionalTool.toolName,
  UltrasoundAnnotation: UltrasoundPleuraBLineTool.toolName,
  SplineROI: SplineROITool.toolName,
  LivewireContour: LivewireContourTool.toolName,
  PlanarFreehandROI: PlanarFreehandROITool.toolName,
  OrientationMarker: OrientationMarkerTool.toolName,
  WindowLevelRegion: WindowLevelRegionTool.toolName,
  PlanarFreehandContourSegmentation: PlanarFreehandContourSegmentationTool.toolName,
  SegmentBidirectional: SegmentBidirectionalTool.toolName,
  SegmentSelect: SegmentSelectTool.toolName,
  SegmentLabel: SegmentLabelTool.toolName,
  LabelmapSlicePropagation: LabelmapSlicePropagationTool.toolName,
  MarkerLabelmap: MarkerLabelmapTool.toolName,
  RegionSegmentPlus: RegionSegmentPlusTool.toolName,
  LivewireContourSegmentation: LivewireContourSegmentationTool.toolName,
  SculptorTool: SculptorTool.toolName,
  SplineContourSegmentation: SplineContourSegmentationTool.toolName,
  LabelMapEditWithContourTool: LabelMapEditWithContourTool.toolName,
};

export { toolNames };
