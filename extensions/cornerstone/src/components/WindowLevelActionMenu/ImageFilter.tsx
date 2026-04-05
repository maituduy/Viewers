import React, { ReactElement, useCallback, useEffect, useState } from 'react';
import { Icons } from '@ohif/ui-next';
import { FilterType } from '../../services/ImageFilterService/ImageFilterService';
import { useSystem } from '@ohif/core';

export type ImageFilterProps = {
  viewportId: string;
};

const filterOptions: { value: FilterType; label: string }[] = [
  { value: 'sharpen', label: 'Sharpen' },
  { value: 'blur', label: 'Blur' },
  { value: 'emboss', label: 'Emboss' },
  { value: 'edges', label: 'Edges' },
];

export function ImageFilter({ viewportId }: ImageFilterProps): ReactElement {
  const { servicesManager } = useSystem();
  const { imageFilterService } = servicesManager.services as any;

  const [activeFilters, setActiveFilters] = useState<FilterType[]>([]);

  useEffect(() => {
    if (imageFilterService) {
      const current = imageFilterService.getActiveFilters(viewportId);
      setActiveFilters(current);
    }
  }, [imageFilterService, viewportId, servicesManager]);

  const handleAddFilter = useCallback(
    (filterType: FilterType) => {
      if (!imageFilterService) {
        return;
      }

      imageFilterService.toggleFilter(viewportId, filterType);
      const newActive = imageFilterService.getActiveFilters(viewportId);
      setActiveFilters(newActive);

      // Trigger viewport re-render
      const { cornerstoneViewportService } = servicesManager.services;
      const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
      if (viewport) {
        viewport.render();
      }
    },
    [imageFilterService, viewportId, servicesManager]
  );

  const handleClearAll = useCallback(() => {
    if (!imageFilterService) {
      return;
    }

    imageFilterService.toggleFilter(viewportId, 'none');
    setActiveFilters([]);

    // Trigger viewport re-render
    const { cornerstoneViewportService } = servicesManager.services;
    const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
    if (viewport) {
      viewport.render();
    }
  }, [imageFilterService, viewportId, servicesManager]);

  const handleRemoveFilterAt = useCallback(
    (index: number) => {
      if (!imageFilterService) {
        return;
      }

      imageFilterService.removeFilterAt(viewportId, index);
      const newActive = imageFilterService.getActiveFilters(viewportId);
      setActiveFilters(newActive);

      const { cornerstoneViewportService } = servicesManager.services;
      const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
      if (viewport) {
        viewport.render();
      }
    },
    [imageFilterService, viewportId, servicesManager]
  );

  if (!imageFilterService) {
    return null;
  }

  return (
    <div className="flex flex-col space-y-3 p-2">
      {/* Active Filters Queue */}
      {activeFilters.length > 0 && (
        <div className="border-l-2 border-primary-main pl-2">
          <p className="text-xs font-semibold text-primary-main mb-1.5">Applied Filters:</p>
          <div className="flex flex-wrap gap-2">
            {activeFilters.map((filter, idx) => (
              <div
                key={`${filter}-${idx}`}
                className="flex items-center gap-1 bg-primary-main text-black px-3 py-1 rounded text-xs font-medium"
              >
                <span>{idx + 1}. {filterOptions.find(f => f.value === filter)?.label}</span>
                <button
                  onClick={() => handleRemoveFilterAt(idx)}
                  className="ml-1 hover:opacity-70 transition-opacity"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={handleClearAll}
            className="mt-2 text-xs text-primary-main hover:text-primary-light transition-colors"
          >
            Clear All
          </button>
        </div>
      )}

      {/* Filter Selection Grid */}
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-secondary-light">Filters:</p>
        <div className="grid grid-cols-2 gap-1.5">
          {filterOptions.map(option => (
            <button
              key={option.value}
              onClick={() => handleAddFilter(option.value)}
              className={`
                flex items-center justify-between px-3 py-2 rounded text-xs font-medium
                transition-colors duration-150
                ${
                  activeFilters.includes(option.value)
                    ? 'bg-primary-main text-black'
                    : 'bg-secondary-dark text-white hover:bg-secondary-light'
                }
              `}
            >
              <span>{option.label}</span>
              {activeFilters.includes(option.value) && (
                <Icons.Checked className="w-3 h-3" />
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
