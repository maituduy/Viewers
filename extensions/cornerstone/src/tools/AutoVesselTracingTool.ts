import { annotation } from '@cornerstonejs/tools';
import { utilities, getRenderingEngine } from '@cornerstonejs/core';
import type { Point3 } from '@cornerstonejs/core/types';
import type { SplineROIAnnotation } from '@cornerstonejs/tools/types/ToolSpecificAnnotationTypes';
import getActiveViewportEnabledElement from '../utils/getActiveViewportEnabledElement';
import { BaseCPRTool } from './BaseCPRTool';

interface VesselPoint {
  world: Point3;
  index: [number, number, number];
  hu: number;
}

/**
 * Auto Vessel Tracing Tool - extends BaseCPRTool with automatic vessel detection
 * Uses Frangi Vesselness Filter for automatic vessel detection
 * Click 2-3 points -> Auto trace vessel centerline -> Render as open spline -> Generate CPR
 */
class AutoVesselTracingTool extends BaseCPRTool {
  static toolName = 'AutoVesselTracing';

  private seedPoints: Point3[] = [];
  private tracedPath: VesselPoint[] = [];
  private isAutoTracing: boolean = false;
  private isCompleted: boolean = false;
  private currentAnnotation: SplineROIAnnotation | null = null;

  // Tracing parameters
  private readonly MIN_SEED_POINTS = 2;
  private readonly HU_THRESHOLD = 200;
  private readonly MIN_POINT_DISTANCE = 1.5;

  // Frangi Vesselness Filter parameters
  private readonly SIGMA_MIN = 0.5;
  private readonly SIGMA_MAX = 2.0;
  private readonly SIGMA_STEPS = 3;
  private readonly FRANGI_ALPHA = 0.5;
  private readonly FRANGI_BETA = 0.5;
  private readonly FRANGI_C = 500;

  private vesselnessCache: Map<string, number> = new Map();

  constructor(toolProps?: any, defaultToolProps?: any) {
    super(toolProps, defaultToolProps);

    // @ts-ignore
    const originalMouseDown = this._mouseDownCallback.bind(this);
    // @ts-ignore
    this._mouseDownCallback = (evt: any) => {
      const isDoubleClick = evt.type === 'CORNERSTONE_TOOLS_MOUSE_DOUBLE_CLICK';
      const { currentPoints } = evt.detail || {};
      const worldPoint = currentPoints?.world ? [...currentPoints.world] as Point3 : null;

      if (isDoubleClick) {
        if (this.seedPoints.length < 1) {
          evt.preventDefault?.();
          return;
        }
        if (worldPoint) {
          this.seedPoints.push(worldPoint);
        }
        originalMouseDown(evt);
        return;
      }

      if (this.seedPoints.length >= 2) return;

      if (worldPoint) {
        this.seedPoints.push(worldPoint);
      }
      originalMouseDown(evt);
    };
  }

  /**
   * Override to allow annotation to be rendered on any slice
   */
  filterInteractableAnnotationsForElement(
    element: HTMLDivElement,
    annotations: SplineROIAnnotation[]
  ): SplineROIAnnotation[] {
    return annotations;
  }

  renderAnnotation = (enabledElement, svgDrawingHelper) => {
    const { viewport } = enabledElement;
    this._renderingViewport = viewport;
    return this._splineRoiToolRenderAnnotation(enabledElement, svgDrawingHelper);
  };

  addNewAnnotation(evt) {
    // Call parent's addNewAnnotation which handles cleanup and wheel scroll
    const result = super.addNewAnnotation(evt);

    const { currentPoints } = evt.detail || {};
    const worldPoint = currentPoints?.world ? [...currentPoints.world] as Point3 : null;

    if (worldPoint && this.seedPoints.length === 0) {
      this.seedPoints.push(worldPoint);
    }

    this.currentAnnotation = result;


    return result;
  }

  cancel(element) {
    this.resetState();
    return super.cancel(element);
  }

  onSetToolActive() {
    super.onSetToolActive();
    this.isCompleted = false;
    this.currentAnnotation = null;
  }

  onSetToolDisabled() {
    super.onSetToolDisabled();
    this.resetState();
  }

  /**
   * Override annotationCompleted to perform auto-tracing before CPR generation
   */
  protected annotationCompleted(evt: any) {
    const { annotation } = evt.detail;

    if (!annotation || annotation.metadata?.toolName !== AutoVesselTracingTool.toolName) {
      return;
    }

    // Perform auto tracing if we have enough seed points
    if (this.seedPoints.length >= this.MIN_SEED_POINTS && !this.isAutoTracing) {
      const { viewportGridService } = (window as any).services;
      const enabledElement = getActiveViewportEnabledElement(viewportGridService);
      const { viewport } = enabledElement;

      try {
        // Perform auto tracing - this modifies annotation.data.handles.points
        this.performAutoTrace(viewport, annotation);

        // Finalize annotation
        (annotation as any).completed = true;
        annotation.invalidated = true;

        const renderingEngine = getRenderingEngine(this._renderingViewport?.renderingEngineId);
        if (renderingEngine) {
          renderingEngine.renderViewport(this._renderingViewport.id);
        }

        this.resetState();
      } catch (error) {
        console.error('Error in auto trace:', error);
      }
    }

    // Call parent's annotationCompleted to handle CPR generation
    super.annotationCompleted(evt);
  }

  private performAutoTrace(viewport: any, annotation: SplineROIAnnotation) {
    this.isAutoTracing = true;

    try {
      const vtkImage = this.getImageDataFromViewport(viewport);
      const dimensions = vtkImage.getDimensions();
      const spacing = vtkImage.getSpacing();
      const scalarData = vtkImage.getPointData().getScalars().getData();

      const seedPointsIndex = this.seedPoints.map(worldPt =>
        utilities.transformWorldToIndex(vtkImage, worldPt)
      );

      this.tracedPath = [];

      if (seedPointsIndex.length === 2) {
        const path = this.findPathBetweenPoints(
          seedPointsIndex[0], seedPointsIndex[1],
          scalarData, dimensions, spacing, vtkImage
        );
        this.tracedPath.push(...path);
      } else if (seedPointsIndex.length === 3) {
        const path1 = this.findPathBetweenPoints(
          seedPointsIndex[0], seedPointsIndex[1],
          scalarData, dimensions, spacing, vtkImage
        );
        this.tracedPath.push(...path1);

        const path2 = this.findPathBetweenPoints(
          seedPointsIndex[1], seedPointsIndex[2],
          scalarData, dimensions, spacing, vtkImage
        );
        if (path2.length > 1) {
          this.tracedPath.push(...path2.slice(1));
        }
      }

      const worldPoints: Point3[] = this.tracedPath.map(pt => {
        const w = pt.world;
        return [Number(w[0]), Number(w[1]), Number(w[2])] as Point3;
      });

      annotation.data.handles.points = worldPoints;
      annotation.invalidated = true;
      annotation.data.contour.closed = false;
      annotation.data.spline.instance.closed = false;

    } catch (error) {
      console.error('Auto trace failed:', error);
    } finally {
      this.isAutoTracing = false;
      this.vesselnessCache.clear();
    }
  }

  private findPathBetweenPoints(
    startPos: number[],
    endPos: number[],
    scalarData: any,
    dimensions: number[],
    spacing: number[],
    imageData: any
  ) {
    const result: VesselPoint[] = [];
    let currentPos: [number, number, number] = [
      Math.round(startPos[0]),
      Math.round(startPos[1]),
      Math.round(startPos[2])
    ];
    const targetPos: [number, number, number] = [
      Math.round(endPos[0]),
      Math.round(endPos[1]),
      Math.round(endPos[2])
    ];

    const startWorld = utilities.transformIndexToWorld(imageData, currentPos);
    result.push({
      world: startWorld as Point3,
      index: currentPos,
      hu: this.getHUValue(scalarData, currentPos, dimensions)
    });

    const maxSteps = 500;
    let step = 0;
    let consecutiveFails = 0;
    const MAX_CONSECUTIVE_FAILS = 5;

    while (step < maxSteps) {
      step++;

      const distToEnd = this.getDistanceInMm(currentPos, targetPos, spacing);
      if (distToEnd < 2.0) break;

      const nextPos = this.findNextVesselPoint(currentPos, targetPos, scalarData, dimensions, spacing);

      if (!nextPos) {
        consecutiveFails++;

        if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          const jumpDist = Math.min(5, distToEnd / 2);
          const dir = this.normalizeVector([
            targetPos[0] - currentPos[0],
            targetPos[1] - currentPos[1],
            targetPos[2] - currentPos[2]
          ]);
          currentPos = [
            Math.round(currentPos[0] + dir[0] * jumpDist / spacing[0]),
            Math.round(currentPos[1] + dir[1] * jumpDist / spacing[1]),
            Math.round(currentPos[2] + dir[2] * jumpDist / spacing[2])
          ];
          consecutiveFails = 0;
          continue;
        }

        const dir = this.normalizeVector([
          targetPos[0] - currentPos[0],
          targetPos[1] - currentPos[1],
          targetPos[2] - currentPos[2]
        ]);
        currentPos = [
          Math.round(currentPos[0] + dir[0]),
          Math.round(currentPos[1] + dir[1]),
          Math.round(currentPos[2] + dir[2])
        ];
        continue;
      }

      consecutiveFails = 0;

      const lastPoint = result[result.length - 1];
      const distFromLast = this.getDistanceInMm(lastPoint.index, nextPos, spacing);

      if (distFromLast >= this.MIN_POINT_DISTANCE) {
        const worldPoint = utilities.transformIndexToWorld(imageData, nextPos);
        result.push({
          world: worldPoint as Point3,
          index: nextPos,
          hu: this.getHUValue(scalarData, nextPos, dimensions)
        });
      }

      currentPos = nextPos;
    }

    const lastPoint = result[result.length - 1];
    if (this.getDistanceInMm(lastPoint.index, targetPos, spacing) >= this.MIN_POINT_DISTANCE) {
      const endWorld = utilities.transformIndexToWorld(imageData, targetPos);
      result.push({
        world: endWorld as Point3,
        index: targetPos,
        hu: this.getHUValue(scalarData, targetPos, dimensions)
      });
    }

    return result;
  }

  private findNextVesselPoint(
    currentPos: number[],
    targetPos: number[],
    scalarData: any,
    dimensions: number[],
    spacing: number[]
  ) {
    const dirToTarget = this.normalizeVector([
      targetPos[0] - currentPos[0],
      targetPos[1] - currentPos[1],
      targetPos[2] - currentPos[2]
    ]);

    const searchRadius = 2;
    let bestPos: [number, number, number] | null = null;
    let bestScore = -Infinity;

    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      for (let dy = -searchRadius; dy <= searchRadius; dy++) {
        for (let dz = -searchRadius; dz <= searchRadius; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;

          const testPos: [number, number, number] = [
            Math.round(currentPos[0] + dx),
            Math.round(currentPos[1] + dy),
            Math.round(currentPos[2] + dz)
          ];

          if (!this.isInBounds(testPos, dimensions)) continue;

          const hu = this.getHUValue(scalarData, testPos, dimensions);
          if (hu < this.HU_THRESHOLD * 0.8) continue;

          const stepDir = this.normalizeVector([
            dx * spacing[0],
            dy * spacing[1],
            dz * spacing[2]
          ]);

          const alignment = stepDir[0] * dirToTarget[0] +
                           stepDir[1] * dirToTarget[1] +
                           stepDir[2] * dirToTarget[2];

          if (alignment < 0.1) continue;

          const vesselScore = this.getVesselnessScore(testPos, scalarData, dimensions, spacing);
          if (vesselScore < 0.05) continue;

          const score = alignment * 100 + vesselScore * 50;

          if (score > bestScore) {
            bestScore = score;
            bestPos = testPos;
          }
        }
      }
    }

    return bestPos;
  }

  private getVesselnessScore(
    pos: number[],
    scalarData: any,
    dimensions: number[],
    spacing: number[]
  ) {
    const key = `${pos[0]},${pos[1]},${pos[2]}`;
    if (this.vesselnessCache.has(key)) {
      return this.vesselnessCache.get(key)!;
    }

    let maxVesselness = 0;

    for (let s = 0; s < this.SIGMA_STEPS; s++) {
      const sigma = this.SIGMA_MIN + (this.SIGMA_MAX - this.SIGMA_MIN) * s / (this.SIGMA_STEPS - 1);
      const vesselness = this.computeVesselnessAtScale(pos, sigma, scalarData, dimensions, spacing);
      maxVesselness = Math.max(maxVesselness, vesselness);
    }

    this.vesselnessCache.set(key, maxVesselness);
    return maxVesselness;
  }

  private computeVesselnessAtScale(
    pos: number[],
    sigma: number,
    scalarData: any,
    dimensions: number[],
    spacing: number[]
  ) {
    const hessian = this.computeHessian(pos, sigma, scalarData, dimensions, spacing);
    const eigenvalues = this.computeEigenvalues3x3(hessian);

    eigenvalues.sort((a, b) => Math.abs(a) - Math.abs(b));
    const [lambda1, lambda2, lambda3] = eigenvalues;

    if (lambda2 >= 0 || lambda3 >= 0) return 0;

    const Ra = Math.abs(lambda2) / Math.abs(lambda3);
    const Rb = Math.abs(lambda1) / Math.sqrt(Math.abs(lambda2 * lambda3));
    const S = Math.sqrt(lambda1 * lambda1 + lambda2 * lambda2 + lambda3 * lambda3);

    const vesselness =
      (1 - Math.exp(-Ra * Ra / (2 * this.FRANGI_ALPHA * this.FRANGI_ALPHA))) *
      Math.exp(-Rb * Rb / (2 * this.FRANGI_BETA * this.FRANGI_BETA)) *
      (1 - Math.exp(-S * S / (2 * this.FRANGI_C * this.FRANGI_C)));

    return vesselness;
  }

  private computeHessian(
    pos: number[],
    sigma: number,
    scalarData: any,
    dimensions: number[],
    spacing: number[]
  ) {
    const hx = Math.max(1, Math.round(sigma / spacing[0]));
    const hy = Math.max(1, Math.round(sigma / spacing[1]));
    const hz = Math.max(1, Math.round(sigma / spacing[2]));

    const x = Math.round(pos[0]);
    const y = Math.round(pos[1]);
    const z = Math.round(pos[2]);

    const getValue = (dx: number, dy: number, dz: number): number => {
      const p = [x + dx, y + dy, z + dz];
      if (!this.isInBounds(p, dimensions)) return 0;
      return this.getHUValue(scalarData, p, dimensions);
    };

    const v000 = getValue(0, 0, 0);

    const Ixx = (getValue(hx, 0, 0) - 2 * v000 + getValue(-hx, 0, 0)) / (hx * hx * spacing[0] * spacing[0]);
    const Iyy = (getValue(0, hy, 0) - 2 * v000 + getValue(0, -hy, 0)) / (hy * hy * spacing[1] * spacing[1]);
    const Izz = (getValue(0, 0, hz) - 2 * v000 + getValue(0, 0, -hz)) / (hz * hz * spacing[2] * spacing[2]);

    const Ixy = (getValue(hx, hy, 0) - getValue(hx, -hy, 0) - getValue(-hx, hy, 0) + getValue(-hx, -hy, 0)) /
                (4 * hx * hy * spacing[0] * spacing[1]);
    const Ixz = (getValue(hx, 0, hz) - getValue(hx, 0, -hz) - getValue(-hx, 0, hz) + getValue(-hx, 0, -hz)) /
                (4 * hx * hz * spacing[0] * spacing[2]);
    const Iyz = (getValue(0, hy, hz) - getValue(0, hy, -hz) - getValue(0, -hy, hz) + getValue(0, -hy, -hz)) /
                (4 * hy * hz * spacing[1] * spacing[2]);

    const s2 = sigma * sigma;
    return [
      [Ixx * s2, Ixy * s2, Ixz * s2],
      [Ixy * s2, Iyy * s2, Iyz * s2],
      [Ixz * s2, Iyz * s2, Izz * s2]
    ];
  }

  private computeEigenvalues3x3(A: number[][]) {
    const a = A[0][0], b = A[0][1], c = A[0][2];
    const d = A[1][1], e = A[1][2];
    const f = A[2][2];

    const p1 = a + d + f;
    const p2 = a*d + a*f + d*f - b*b - c*c - e*e;
    const p3 = a*d*f + 2*b*c*e - a*e*e - d*c*c - f*b*b;

    const q = (3*p2 - p1*p1) / 9;
    const r = (9*p1*p2 - 27*p3 - 2*p1*p1*p1) / 54;

    const discriminant = q*q*q + r*r;

    if (discriminant < 0) {
      const theta = Math.acos(r / Math.sqrt(-q*q*q));
      const sqrtQ = Math.sqrt(-q);

      return [
        2 * sqrtQ * Math.cos(theta / 3) + p1 / 3,
        2 * sqrtQ * Math.cos((theta + 2*Math.PI) / 3) + p1 / 3,
        2 * sqrtQ * Math.cos((theta + 4*Math.PI) / 3) + p1 / 3
      ];
    } else {
      const s = Math.cbrt(r + Math.sqrt(discriminant));
      const t = Math.cbrt(r - Math.sqrt(discriminant));

      const lambda1 = s + t + p1 / 3;
      const lambda2 = -(s + t) / 2 + p1 / 3;

      return [lambda1, lambda2, lambda2];
    }
  }

  private getDistanceInMm(pos1: number[], pos2: number[], spacing: number[]) {
    const dx = (pos1[0] - pos2[0]) * spacing[0];
    const dy = (pos1[1] - pos2[1]) * spacing[1];
    const dz = (pos1[2] - pos2[2]) * spacing[2];
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
  }

  private normalizeVector(v: number[]) {
    const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
    if (len === 0) return [0, 0, 1];
    return [v[0]/len, v[1]/len, v[2]/len];
  }

  private getHUValue(scalarData: any, indexPos: number[], dimensions: number[]) {
    const [x, y, z] = indexPos.map(Math.round);
    const index = z * dimensions[0] * dimensions[1] + y * dimensions[0] + x;
    return scalarData[index] || 0;
  }

  private isInBounds(pos: number[], dimensions: number[]) {
    return pos[0] >= 0 && pos[0] < dimensions[0] &&
           pos[1] >= 0 && pos[1] < dimensions[1] &&
           pos[2] >= 0 && pos[2] < dimensions[2];
  }

  private resetState() {
    this.seedPoints = [];
    this.isCompleted = false;
    this.currentAnnotation = null;
    this.isAutoTracing = false;
  }
}

export default AutoVesselTracingTool;
