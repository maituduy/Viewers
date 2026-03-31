import React, { useEffect, useCallback, useState, ReactElement, useMemo, useRef } from 'react';
import PropTypes from 'prop-types';
import debounce from 'lodash.debounce';
import { PanelSection, WindowLevel } from '@ohif/ui-next';
import { BaseVolumeViewport, Enums, eventTarget } from '@cornerstonejs/core';
import { useActiveViewportDisplaySets } from '@ohif/core';
import {
  getNodeOpacity,
  isPetVolumeWithDefaultOpacity,
  isVolumeWithConstantOpacity,
  getWindowLevelsData,
} from './utils';

const { Events } = Enums;

const ViewportWindowLevel = ({
  servicesManager,
  viewportId,
}: withAppTypes<{
  viewportId: string;
}>): ReactElement => {
  const { cornerstoneViewportService } = servicesManager.services;
  const [windowLevels, setWindowLevels] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const displaySets = useActiveViewportDisplaySets();
  const recentViewportIdRef = useRef<string | null>(null);

  const getViewportsWithVolumeIds = useCallback(
    (volumeIds: string[]) => {
      const renderingEngine = cornerstoneViewportService.getRenderingEngine();
      const viewports = renderingEngine.getVolumeViewports();

      return viewports.filter(vp => {
        const viewportVolumeIds = vp instanceof BaseVolumeViewport ? vp.getAllVolumeIds() : [];
        return (
          volumeIds.length === viewportVolumeIds.length &&
          volumeIds.every(volumeId => viewportVolumeIds.includes(volumeId))
        );
      });
    },
    [cornerstoneViewportService]
  );

  const getVolumeOpacity = useCallback((viewport, volumeId) => {
    const volumeActor = viewport.getActors().find(actor => actor.referencedId === volumeId)?.actor;

    if (isPetVolumeWithDefaultOpacity(volumeId, volumeActor)) {
      return getNodeOpacity(volumeActor, 1);
    } else if (isVolumeWithConstantOpacity(volumeActor)) {
      return getNodeOpacity(volumeActor, 0);
    }

    return undefined;
  }, []);

  const updateViewportHistograms = useCallback(() => {
    const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
    const viewportInfo = cornerstoneViewportService.getViewportInfo(viewportId);

    getWindowLevelsData(viewport, viewportInfo, getVolumeOpacity).then(data => {
      setWindowLevels(data);
    });
  }, [viewportId, cornerstoneViewportService, getVolumeOpacity]);

  const handleCornerstoneVOIModified = useCallback(
    e => {
      const { detail } = e;
      const { volumeId, range } = detail;
      const oldWindowLevel = windowLevels.find(wl => wl.volumeId === volumeId);

      if (!oldWindowLevel) {
        return;
      }

      const oldVOI = oldWindowLevel.voi;
      const windowWidth = range.upper - range.lower;
      const windowCenter = range.lower + windowWidth / 2;

      const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
      const isVolume3D =
        viewport?.type === Enums.ViewportType.VOLUME_3D ||
        viewport?.type === Enums.ViewportType.PERSPECTIVE;

      if (isVolume3D) {
        if (typeof window !== 'undefined') {
          (window as any).__OHIF_WL_PANEL_EVENT_CALLS__ =
            ((window as any).__OHIF_WL_PANEL_EVENT_CALLS__ || 0) + 1;
          if ((window as any).__OHIF_WL_PANEL_EVENT_CALLS__ <= 20) {
            console.log('[WL-TRACE][Panel.VOI_MODIFIED]', {
              call: (window as any).__OHIF_WL_PANEL_EVENT_CALLS__,
              viewportId,
              viewportType: viewport?.type,
              volumeId,
              windowWidth,
              windowCenter,
            });
          }
        }

        const widthDelta = windowWidth - oldVOI.windowWidth;
        const centerDelta = windowCenter - oldVOI.windowCenter;
        const MAX_WIDTH_DELTA_PER_EVENT = 250;
        const MAX_CENTER_DELTA_PER_EVENT = 120;

        const isSpike =
          Math.abs(widthDelta) > MAX_WIDTH_DELTA_PER_EVENT ||
          Math.abs(centerDelta) > MAX_CENTER_DELTA_PER_EVENT;

        if (isSpike) {
          const clampedWindowWidth = Math.max(
            1,
            oldVOI.windowWidth +
              Math.max(
                -MAX_WIDTH_DELTA_PER_EVENT,
                Math.min(MAX_WIDTH_DELTA_PER_EVENT, widthDelta)
              )
          );
          const clampedWindowCenter =
            oldVOI.windowCenter +
            Math.max(
              -MAX_CENTER_DELTA_PER_EVENT,
              Math.min(MAX_CENTER_DELTA_PER_EVENT, centerDelta)
            );

          const clampedRange = {
            lower: clampedWindowCenter - clampedWindowWidth / 2,
            upper: clampedWindowCenter + clampedWindowWidth / 2,
          };

          if (viewport) {
            (viewport as any).setProperties({ voiRange: clampedRange }, volumeId);
            viewport.render();
          }

          console.log('[WL-3D-SOFT-GUARD][Panel]', {
            volumeId,
            oldVOI,
            requested: { windowWidth, windowCenter },
            clamped: { windowWidth: clampedWindowWidth, windowCenter: clampedWindowCenter },
            viewportType: viewport?.type,
          });

          setWindowLevels(
            windowLevels.map(windowLevel =>
              windowLevel === oldWindowLevel
                ? {
                    ...oldWindowLevel,
                    voi: {
                      windowWidth: clampedWindowWidth,
                      windowCenter: clampedWindowCenter,
                    },
                  }
                : windowLevel
            )
          );

          return;
        }
      }

      if (windowWidth === oldVOI.windowWidth && windowCenter === oldVOI.windowCenter) {
        return;
      }

      const newWindowLevel = {
        ...oldWindowLevel,
        voi: {
          windowWidth,
          windowCenter,
        },
      };

      setWindowLevels(
        windowLevels.map(windowLevel =>
          windowLevel === oldWindowLevel ? newWindowLevel : windowLevel
        )
      );
    },
    [windowLevels, cornerstoneViewportService, viewportId]
  );

  const debouncedHandleCornerstoneVOIModified = useMemo(
    () => debounce(handleCornerstoneVOIModified, 100),
    [handleCornerstoneVOIModified]
  );

  const handleVOIChange = useCallback(
    (volumeId, voi) => {
      const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

      if (!viewport) {
        return;
      }

      const requestedRange = {
        lower: voi.windowCenter - voi.windowWidth / 2,
        upper: voi.windowCenter + voi.windowWidth / 2,
      };

      let newRange = requestedRange;

      if (
        viewport?.type === Enums.ViewportType.VOLUME_3D ||
        viewport?.type === Enums.ViewportType.PERSPECTIVE
      ) {
        if (typeof window !== 'undefined') {
          (window as any).__OHIF_WL_PANEL_INPUT_CALLS__ =
            ((window as any).__OHIF_WL_PANEL_INPUT_CALLS__ || 0) + 1;
          if ((window as any).__OHIF_WL_PANEL_INPUT_CALLS__ <= 20) {
            console.log('[WL-TRACE][Panel.handleVOIChange]', {
              call: (window as any).__OHIF_WL_PANEL_INPUT_CALLS__,
              viewportId,
              viewportType: viewport?.type,
              volumeId,
              requestedRange,
            });
          }
        }

        const currentVoiRange =
          viewport instanceof BaseVolumeViewport
            ? viewport.getProperties(volumeId)?.voiRange
            : viewport.getProperties()?.voiRange;

        if (currentVoiRange) {
          const currentWindowWidth = currentVoiRange.upper - currentVoiRange.lower;
          const currentWindowCenter = currentVoiRange.lower + currentWindowWidth / 2;
          const requestedWindowWidth = requestedRange.upper - requestedRange.lower;
          const requestedWindowCenter = requestedRange.lower + requestedWindowWidth / 2;

          const isLikelyStaleEventFromOtherViewport =
            Math.abs(requestedWindowWidth - currentWindowWidth) > 1200 ||
            Math.abs(requestedWindowCenter - currentWindowCenter) > 600;

          if (isLikelyStaleEventFromOtherViewport) {
            // Ignore first stale WL drag after switching from 2D -> 3D and resync UI with current 3D VOI.
            setWindowLevels(prev =>
              prev.map(windowLevel =>
                windowLevel.volumeId === volumeId
                  ? {
                      ...windowLevel,
                      voi: {
                        windowWidth: currentWindowWidth,
                        windowCenter: currentWindowCenter,
                      },
                    }
                  : windowLevel
              )
            );
            return;
          }

          // Guard against occasional first-drag spikes coming from slider range re-sync.
          const MAX_WIDTH_DELTA_PER_EVENT = 300;
          const MAX_CENTER_DELTA_PER_EVENT = 150;

          const clampedWindowWidth = Math.max(
            1,
            currentWindowWidth +
              Math.max(
                -MAX_WIDTH_DELTA_PER_EVENT,
                Math.min(MAX_WIDTH_DELTA_PER_EVENT, requestedWindowWidth - currentWindowWidth)
              )
          );

          const clampedWindowCenter =
            currentWindowCenter +
            Math.max(
              -MAX_CENTER_DELTA_PER_EVENT,
              Math.min(MAX_CENTER_DELTA_PER_EVENT, requestedWindowCenter - currentWindowCenter)
            );

          const clampedRequestedRange = {
            lower: clampedWindowCenter - clampedWindowWidth / 2,
            upper: clampedWindowCenter + clampedWindowWidth / 2,
          };

          // 3D WL slider updates are very sensitive; blend with current VOI to reduce speed by 50%.
          newRange = {
            lower: currentVoiRange.lower + (clampedRequestedRange.lower - currentVoiRange.lower) * 0.5,
            upper: currentVoiRange.upper + (clampedRequestedRange.upper - currentVoiRange.upper) * 0.5,
          };
        }
      }

      (viewport as any).setProperties({ voiRange: newRange }, volumeId);
      viewport.render();
    },
    [cornerstoneViewportService, viewportId]
  );

  useEffect(() => {
    if (recentViewportIdRef.current !== viewportId) {
      recentViewportIdRef.current = viewportId;
      setWindowLevels([]);
      setIsLoading(true);
    }
  }, [viewportId]);

  const handleOpacityChange = useCallback(
    (viewportId, _volumeIndex, volumeId, opacity) => {
      const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

      if (!viewport) {
        return;
      }

      const viewportVolumeIds =
        viewport instanceof BaseVolumeViewport ? viewport.getAllVolumeIds() : [];
      const viewports = getViewportsWithVolumeIds(viewportVolumeIds);

      viewports.forEach(vp => {
        vp.setProperties({ colormap: { opacity } }, volumeId);
        vp.render();
      });
    },
    [getViewportsWithVolumeIds, cornerstoneViewportService]
  );

  // New function to handle image volume loading completion
  const handleImageVolumeLoadingCompleted = useCallback(() => {
    setIsLoading(false);
    updateViewportHistograms();
  }, [updateViewportHistograms]);

  // Listen to cornerstone events and set up interval for histogram updates
  useEffect(() => {
    document.addEventListener(Events.VOI_MODIFIED, debouncedHandleCornerstoneVOIModified, true);
    eventTarget.addEventListener(
      Events.IMAGE_VOLUME_LOADING_COMPLETED,
      handleImageVolumeLoadingCompleted
    );

    const intervalId = setInterval(() => {
      if (isLoading) {
        updateViewportHistograms();
      }
    }, 1000);

    return () => {
      document.removeEventListener(
        Events.VOI_MODIFIED,
        debouncedHandleCornerstoneVOIModified,
        true
      );
      eventTarget.removeEventListener(
        Events.IMAGE_VOLUME_LOADING_COMPLETED,
        handleImageVolumeLoadingCompleted
      );
      clearInterval(intervalId);
    };
  }, [
    updateViewportHistograms,
    debouncedHandleCornerstoneVOIModified,
    handleImageVolumeLoadingCompleted,
    isLoading,
  ]);

  // Create a memoized version of displaySet IDs for comparison
  const displaySetIds = useMemo(() => {
    return displaySets?.map(ds => ds.displaySetInstanceUID).sort() || [];
  }, [displaySets]);

  useEffect(() => {
    const { unsubscribe } = cornerstoneViewportService.subscribe(
      cornerstoneViewportService.EVENTS.VIEWPORT_VOLUMES_CHANGED,
      ({ viewportInfo }) => {
        if (viewportInfo.viewportId === viewportId) {
          updateViewportHistograms();
        }
      }
    );

    // Only update if displaySets actually changed and are loaded
    if (displaySetIds.length && !isLoading) {
      updateViewportHistograms();
    }

    return () => {
      unsubscribe();
    };
  }, [viewportId, cornerstoneViewportService, updateViewportHistograms, displaySetIds, isLoading]);

  return (
    <PanelSection defaultOpen={true}>
      <PanelSection.Header>Window Level</PanelSection.Header>
      <PanelSection.Content className="bg-muted py-1">
        {windowLevels.map((windowLevel, i) => {
          if (!windowLevel.histogram) {
            return null;
          }

          return (
            <WindowLevel
              key={`${windowLevel.viewportId}-${windowLevel.volumeId}`}
              histogram={windowLevel.histogram}
              voi={windowLevel.voi}
              step={windowLevel.step}
              showOpacitySlider={windowLevel.showOpacitySlider}
              colormap={windowLevel.colormap}
              onVOIChange={voi => handleVOIChange(windowLevel.volumeId, voi)}
              opacity={windowLevel.opacity}
              onOpacityChange={opacity =>
                handleOpacityChange(windowLevel.viewportId, i, windowLevel.volumeId, opacity)
              }
            />
          );
        })}
        {windowLevels.length === 0 && !isLoading && (
          <div className="text-muted-foreground py-2 text-center text-sm">
            No window level data available
          </div>
        )}
      </PanelSection.Content>
    </PanelSection>
  );
};

ViewportWindowLevel.propTypes = {
  servicesManager: PropTypes.object.isRequired,
  viewportId: PropTypes.string.isRequired,
};

export default ViewportWindowLevel;
