import React, { ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { AllInOneMenu, Icons } from '@ohif/ui-next';
import { useSystem } from '@ohif/core';
import { CONSTANTS, Enums } from '@cornerstonejs/core';
import { useTranslation } from 'react-i18next';

type RenderingMethod = 'vr' | 'mip' | 'minip' | 'avg';

const METHODS: Array<{ value: RenderingMethod; label: string }> = [
  { value: 'vr', label: 'VR' },
  { value: 'mip', label: 'MIP' },
  { value: 'minip', label: 'MinIP' },
  { value: 'avg', label: 'AVG' },
];

function blendModeToMethod(blendMode: Enums.BlendModes | undefined): RenderingMethod {
  if (blendMode === Enums.BlendModes.MAXIMUM_INTENSITY_BLEND) {
    return 'mip';
  }

  if (blendMode === Enums.BlendModes.MINIMUM_INTENSITY_BLEND) {
    return 'minip';
  }

  if (blendMode === Enums.BlendModes.AVERAGE_INTENSITY_BLEND) {
    return 'avg';
  }

  return 'vr';
}

function getFullVolumeSlabThickness(viewport): number | null {
  const actorEntries = viewport?.getActors?.();
  const imageData = actorEntries?.[0]?.actor?.getMapper?.()?.getInputData?.();
  const dimensions = imageData?.getDimensions?.();
  const spacing = imageData?.getSpacing?.();

  if (!dimensions || !spacing || dimensions.length < 3 || spacing.length < 3) {
    return null;
  }

  return Math.sqrt(
    (dimensions[0] * spacing[0]) ** 2 +
      (dimensions[1] * spacing[1]) ** 2 +
      (dimensions[2] * spacing[2]) ** 2
  );
}

export function VolumeRenderingMethods({ viewportId }: { viewportId?: string } = {}): ReactElement {
  const { servicesManager } = useSystem();
  const { cornerstoneViewportService } = servicesManager.services;
  const [selectedMethod, setSelectedMethod] = useState<RenderingMethod>('vr');
  const { t } = useTranslation('WindowLevelActionMenu');

  const methods = useMemo(
    () =>
      METHODS.map(method => ({
        ...method,
        label: t(method.label, method.label),
      })),
    [t]
  );

  useEffect(() => {
    if (!viewportId) {
      return;
    }

    const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
    const currentBlendMode = viewport?.getBlendMode?.();
    setSelectedMethod(blendModeToMethod(currentBlendMode));
  }, [cornerstoneViewportService, viewportId]);

  const onMethodChange = useCallback(
    (method: RenderingMethod) => {
      if (!viewportId) {
        return;
      }

      const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

      if (!viewport?.setBlendMode) {
        return;
      }

      let blendMode = Enums.BlendModes.COMPOSITE;

      if (method === 'mip') {
        blendMode = Enums.BlendModes.MAXIMUM_INTENSITY_BLEND;
      } else if (method === 'minip') {
        blendMode = Enums.BlendModes.MINIMUM_INTENSITY_BLEND;
      } else if (method === 'avg') {
        blendMode = Enums.BlendModes.AVERAGE_INTENSITY_BLEND;
      }

      viewport.setBlendMode(blendMode);

      // Keep actor-level mappers in sync for viewports that do not apply blend mode consistently.
      const actorEntries = viewport.getActors?.() || [];
      actorEntries.forEach(entry => {
        entry?.actor?.getMapper?.()?.setBlendMode?.(blendMode);
      });

      if (method === 'vr') {
        if (viewport.resetSlabThickness) {
          viewport.resetSlabThickness();
        } else if (viewport.setSlabThickness) {
          viewport.setSlabThickness(CONSTANTS.RENDERING_DEFAULTS.MINIMUM_SLAB_THICKNESS);
        }
      } else {
        const fullVolumeSlabThickness = getFullVolumeSlabThickness(viewport);
        if (fullVolumeSlabThickness && viewport.setSlabThickness) {
          viewport.setSlabThickness(fullVolumeSlabThickness);
        }
      }

      // Get actual data range via cornerstone3D's voxelManager (NOT VTK standard scalars).
      const vtkImageData = actorEntries?.[0]?.actor?.getMapper?.()?.getInputData?.();
      let dataMin: number | undefined;
      let dataMax: number | undefined;
      try {
        const voxelManagerContainer = (vtkImageData as any)?.get?.('voxelManager');
        const range = voxelManagerContainer?.voxelManager?.getRange?.();
        if (range && range.length >= 2) {
          dataMin = range[0];
          dataMax = range[1];
        }
      } catch {
        // voxelManager not available
      }

      // Direct VTK transfer-function manipulation.
      //
      // IMPORTANT: viewport.setProperties({ voiRange }) only calls cfun.setRange() which
      // RESCALES the existing complex VR-preset CTF shape — it does NOT replace it with a
      // simple grayscale. As a result, brightness/contrast look wrong for MIP/MinIP/AVG.
      //
      // Fix: for non-VR modes, replace the CTF with a 2-point grayscale and flatten the
      // opacity function so all intensities contribute. Save and restore the original VR
      // functions when switching back to VR.
      const actor = actorEntries?.[0]?.actor;
      const property = (actor as any)?.getProperty?.();
      const cfun = property?.getRGBTransferFunction?.(0);
      const ofun = property?.getScalarOpacity?.(0);

      if (method === 'vr') {
        // Restore saved VR transfer functions so VR still looks correct.
        const saved = (viewport as any).__vrTransferFunctionSave;
        if (saved && cfun && ofun) {
          try {
            cfun.removeAllPoints?.();
            saved.ctfPoints.forEach((node: number[]) => cfun.addRGBPoint?.(...node));
            ofun.removeAllPoints?.();
            saved.opacityPoints.forEach((node: number[]) => ofun.addPoint?.(...node));
          } catch {
            // ignore
          }
        }
      } else {
        // Save VR functions before the first modification so we can restore them later.
        // ALSO capture the DICOM-derived voiRange: OHIF applies DICOM WW/WL via
        // setProperties({ voiRange }) at initialization which calls cfun.setRange(), so
        // cfun.getRange() at this point equals the DICOM-recommended range (the same range
        // that reference viewers like SIGNA Creator use for their default MIP display).
        if (!(viewport as any).__vrTransferFunctionSave && cfun && ofun) {
          try {
            const cfRange = cfun.getRange?.();
            if (cfRange && cfRange.length >= 2 && cfRange[1] > cfRange[0]) {
              (viewport as any).__dicomVoiRange = { lower: cfRange[0], upper: cfRange[1] };
            }
            const ctfPoints: number[][] = [];
            const ctfSize: number = cfun.getSize?.() ?? 0;
            for (let i = 0; i < ctfSize; i++) {
              const node = [0, 0, 0, 0, 0, 0];
              cfun.getNodeValue?.(i, node);
              ctfPoints.push([...node]);
            }
            const opacityPoints: number[][] = [];
            const opacitySize: number = ofun.getSize?.() ?? 0;
            for (let i = 0; i < opacitySize; i++) {
              const node = [0, 0, 0, 0];
              ofun.getNodeValue?.(i, node);
              opacityPoints.push([...node]);
            }
            (viewport as any).__vrTransferFunctionSave = { ctfPoints, opacityPoints };
          } catch {
            // ignore
          }
        }

        // Compute window bounds from the actual data range (voxelManager).
        // For MIP on TOF MRA: lower at 15% cuts background; upper at 30% puts vessels
        // at the saturation point, giving gray tissue + white vessels appearance.
        const span = dataMin !== undefined && dataMax !== undefined ? dataMax - dataMin : 0;

        let lowerBound: number | undefined;
        let upperBound: number | undefined;

        if (dataMin !== undefined && span > 0) {
          if (method === 'mip') {
            lowerBound = dataMin + span * 0.15;
            upperBound = dataMin + span * 0.3;
          } else if (method === 'minip') {
            lowerBound = dataMin;
            upperBound = dataMin + span * 0.15;
          } else {
            // avg
            lowerBound = dataMin + span * 0.1;
            upperBound = dataMin + span * 0.5;
          }
        }

        if (lowerBound !== undefined && upperBound !== undefined) {
          // Replace CTF with a simple 2-point grayscale: lower→black, upper→white.
          if (cfun) {
            try {
              cfun.removeAllPoints?.();
              cfun.addRGBPoint?.(lowerBound, 0, 0, 0);
              cfun.addRGBPoint?.(upperBound, 1, 1, 1);
              cfun.setClamping?.(1); // values above upperBound stay white
            } catch {
              // ignore
            }
          }

          // Flatten opacity so all intensities fully contribute to the projection.
          if (ofun) {
            try {
              ofun.removeAllPoints?.();
              ofun.addPoint?.(dataMin ?? lowerBound, 1);
              ofun.addPoint?.(dataMax ?? upperBound, 1);
            } catch {
              // ignore
            }
          }

          // Update OHIF's internal WL drag baseline so subsequent manual drag works correctly.
          const referencedId = actorEntries?.[0]?.referencedId;
          const vp = viewport as any;
          vp.__ohifWL3DBaselineByVolumeId = vp.__ohifWL3DBaselineByVolumeId || {};
          if (referencedId) {
            vp.__ohifWL3DBaselineByVolumeId[referencedId] = { lower: lowerBound, upper: upperBound };
          }
          vp.__ohifWL3DFallbackVoiRange = { lower: lowerBound, upper: upperBound };
        }
      }

      viewport.render();
      setSelectedMethod(method);
    },
    [cornerstoneViewportService, viewportId]
  );

  return (
    <AllInOneMenu.ItemPanel>
      {methods.map(method => (
        <AllInOneMenu.Item
          key={method.value}
          label={method.label}
          icon={selectedMethod === method.value ? <Icons.Checked /> : undefined}
          useIconSpace={true}
          onClick={() => onMethodChange(method.value)}
        />
      ))}
    </AllInOneMenu.ItemPanel>
  );
}
