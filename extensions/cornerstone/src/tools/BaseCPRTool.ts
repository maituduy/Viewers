import { annotation, SplineROITool } from '@cornerstonejs/tools';
import type { AnnotationRenderContext } from "@cornerstonejs/tools/types";
import type { SplineROIAnnotation } from "@cornerstonejs/tools/types/ToolSpecificAnnotationTypes";
import getActiveViewportEnabledElement from '../utils/getActiveViewportEnabledElement';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import { utilities, getEnabledElement } from '@cornerstonejs/core';
import CprWrapper from '../utils/CprWrapper';
import { servicesManager } from '@ohif/app/src/App';
import { Point3 } from '@cornerstonejs/core/types';

/**
 * Base class for CPR-enabled spline tools
 * Handles common CPR generation, rotation, and rendering logic
 */
export abstract class BaseCPRTool extends SplineROITool {
  _renderingViewport: any;
  _splineRoiToolRenderAnnotation = this.renderAnnotation;
  _origTriggerModified = this.triggerAnnotationModified;
  _currentCPR: CprWrapper | null = null;
  _currentRotation: number = 0;

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
    const result = super.addNewAnnotation(evt);

    // Clean old annotations after new one is added to state
    setTimeout(() => {
      this.cleanOldAnnotations();
    }, 0);

    // Enable wheel scroll during drawing
    const element = evt.detail?.element || evt.element;
    this.enableWhileDrawingScroll(element);

    return result;
  }

  /**
   * Enable wheel scroll while drawing annotation
   */
  private enableWhileDrawingScroll(element: HTMLElement) {
    if (!element) return;

    // Remove existing listener if any
    if ((element as any)._drawingWheelListener) {
      element.removeEventListener('wheel', (element as any)._drawingWheelListener);
    }

    const wheelHandler = (evt: WheelEvent) => {
      try {
        const enabledElement = getEnabledElement(element);
        if (!enabledElement) return;

        const { viewport } = enabledElement;
        if (!viewport) return;

        const delta = evt.deltaY > 0 ? 1 : -1;
        utilities.scroll(viewport, { delta });

        evt.preventDefault();
        evt.stopPropagation();
      } catch (error) {
        console.warn('Wheel scroll error:', error);
      }
    };

    (element as any)._drawingWheelListener = wheelHandler;
    element.addEventListener('wheel', wheelHandler, { passive: false });
  }

  /**
   * Wrap parent's triggerAnnotationModified to handle updates and re-render CPR
   */
  triggerAnnotationModified = (annotation, enabledElement, changeType) => {
    this._origTriggerModified(annotation, enabledElement, changeType);
    const evt = { detail: { annotation, enabledElement } };
    this.annotationCompleted(evt);
  }

  protected annotationCompleted(evt: any) {
    super.annotationCompleted(evt);

    const { cornerstoneViewportService, viewportGridService } = servicesManager.services;
    const annotationAddedEventDetail = evt.detail;
    const { annotation: { data: annotationData } } = annotationAddedEventDetail;

    const enabledElement = getActiveViewportEnabledElement(viewportGridService);
    const { viewport } = enabledElement;

    const plane = cornerstoneViewportService.getOrientation(viewport.id);
    const points = annotationData.handles.points;
    const image = this.getImageDataFromViewport(viewport);
    const spacing = image.getSpacing();

    // Transform points to world coordinates
    let worldPoints = points
      .map((point: Point3) => utilities.transformWorldToIndex(image, point))
      .map((point: number[]) => [
        point[0] * spacing[0],
        point[1] * spacing[1],
        (image.getDimensions()[2] - 1 - point[2]) * spacing[2]
      ]);

    image.setOrigin([0, 0, 0]);

    const cprViewportId = "cpr";
    const cprViewport = cornerstoneViewportService.getCornerstoneViewport(cprViewportId);

    // Create or reuse CPR instance
    if (this._currentCPR) {
      this._currentCPR = null;
    }

    this._currentCPR = new CprWrapper(cprViewport, image, plane);
    this._currentRotation = 0; // Reset rotation

    function flipPointsAlongZ(points, dimensions, spacing) {
      const sizeZ = dimensions[2] * spacing[2];
      return points.map(([x, y, z]) => {
        const flippedZ = sizeZ - z;
        return [x, y, flippedZ];
      });
    }

    if (plane !== "axial") {
      worldPoints = flipPointsAlongZ(worldPoints, image.getDimensions(), image.getSpacing());
    }

    // Set centerline and render
    this._currentCPR.setCenterline(worldPoints);
    this._currentCPR.safeRender();

    const { voiRange } = viewport.getProperties();
    this._currentCPR.setVOI(voiRange);

    this.removeBlackOverlay("cpr");

    // Setup scroll rotation on CPR viewport
    this.setupCPRScrollRotation(cprViewport);
  }

  /**
   * Setup wheel scroll to rotate CPR
   */
  protected setupCPRScrollRotation(cprViewport: any) {
    const element = cprViewport.element;

    // Remove old listener if exists
    if ((element as any)._cprWheelListener) {
      element.removeEventListener('wheel', (element as any)._cprWheelListener);
    }

    const wheelHandler = (evt: WheelEvent) => {
      evt.preventDefault();
      evt.stopPropagation();

      if (!this._currentCPR) {
        console.warn('No current CPR instance');
        return;
      }

      // Rotate ±5 degrees per wheel tick
      const delta = evt.deltaY > 0 ? 5 : -5;
      this._currentRotation += delta;
      this._currentRotation = ((this._currentRotation % 360) + 360) % 360;

      this._currentCPR.rotateCPR(this._currentRotation);
    };

    (element as any)._cprWheelListener = wheelHandler;
    element.addEventListener('wheel', wheelHandler, { passive: false });
  }

  /**
   * Override renderAnnotationInstance to force spline rendering to be open
   */
  protected renderAnnotationInstance(renderContext: AnnotationRenderContext): boolean {
    const annotation = renderContext.annotation as SplineROIAnnotation;
    const originalClosed = annotation.data.contour.closed;
    const originalSplineClosed = annotation.data.spline.instance.closed;

    try {
      annotation.data.contour.closed = false;
      annotation.data.spline.instance.closed = false;

      const getChildAnnotations = (this as any).getChildAnnotations ||
        ((window as any).cornerstoneTools?.getChildAnnotations);

      const childAnnotations = getChildAnnotations ? getChildAnnotations(annotation) : [];
      const allAnnotations = [annotation, ...childAnnotations].filter(
        (ann) => ann && (this as any)._isSplineROIAnnotation(ann)
      ) as SplineROIAnnotation[];

      const originalStates = allAnnotations.map(ann => ({
        annotation: ann,
        contourClosed: ann.data.contour.closed,
        splineClosed: ann.data.spline.instance.closed
      }));

      allAnnotations.forEach(ann => {
        ann.data.contour.closed = false;
        ann.data.spline.instance.closed = false;
      });

      const result = super.renderAnnotationInstance(renderContext);

      originalStates.forEach(state => {
        state.annotation.data.contour.closed = state.contourClosed;
        state.annotation.data.spline.instance.closed = state.splineClosed;
      });

      return result;
    } catch (error) {
      annotation.data.contour.closed = originalClosed;
      annotation.data.spline.instance.closed = originalSplineClosed;
      throw error;
    }
  }

  /**
   * Helper: Get VTK image data from viewport
   */
  protected getImageDataFromViewport(viewport): any {
    try {
      const csImageData = viewport.getImageData();
      const dimensions = csImageData.dimensions;
      const spacing = csImageData.spacing;
      const origin = csImageData.origin;

      let scalarData = csImageData.voxelManager.getCompleteScalarDataArray();
      const scalarDataCopy = new scalarData.constructor(scalarData);

      const vtkImage = vtkImageData.newInstance();
      vtkImage.setDimensions(dimensions as [number, number, number]);
      vtkImage.setSpacing(spacing as [number, number, number]);
      vtkImage.setOrigin(origin as [number, number, number]);

      const dataArray = vtkDataArray.newInstance({
        name: 'Scalars',
        numberOfComponents: 1,
        values: scalarDataCopy,
      });
      vtkImage.getPointData().setScalars(dataArray);

      return vtkImage;
    } catch (error) {
      console.error('Error creating VTK image data:', error);
      throw new Error(`Failed to create VTK image: ${error.message}`);
    }
  }

  /**
   * Helper: Remove black overlay from CPR viewport
   */
  protected removeBlackOverlay(viewportId: string) {
    const viewportElement = document.querySelector(`[data-viewportid="${viewportId}"]`);
    if (!viewportElement) return;
    const overlayWrapper = viewportElement.querySelector('.cpr-black-overlay-wrapper');
    if (overlayWrapper) overlayWrapper.remove();
  }

  /**
   * Helper: Clean old annotations of the same tool type
   */
  protected cleanOldAnnotations() {
    const toolName = (this.constructor as any).toolName;
    const allAnnotations = annotation.state.getAllAnnotations();
    const splineAnnotations = allAnnotations.filter(ann => ann.metadata.toolName === toolName);

    if (splineAnnotations.length > 1) {
      const toRemove = splineAnnotations.slice(0, -1);
      toRemove.forEach(ann => {
        annotation.state.removeAnnotation(ann.annotationUID);
      });
    }
  }
}
