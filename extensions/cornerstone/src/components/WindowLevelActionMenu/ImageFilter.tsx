import React, { ReactElement, useCallback, useEffect, useState } from 'react';
import { Icons } from '@ohif/ui-next';
import { FilterType } from '../../services/ImageFilterService/ImageFilterService';
import { useSystem } from '@ohif/core';

export type ImageFilterProps = {
  viewportId: string;
};

const filterOptions: { value: FilterType; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'sharpen', label: 'Sharpen' },
  { value: 'blur', label: 'Blur' },
  { value: 'emboss', label: 'Emboss' },
  { value: 'edges', label: 'Edges' },
];

export function ImageFilter({ viewportId }: ImageFilterProps): ReactElement {
  const { servicesManager } = useSystem();
  const { imageFilterService } = servicesManager.services as any;

  const [selectedFilter, setSelectedFilter] = useState<FilterType>('none');

  useEffect(() => {
    if (imageFilterService) {
      const currentFilter = imageFilterService.getFilter(viewportId);
      setSelectedFilter(currentFilter);
    }
  }, [imageFilterService, viewportId, servicesManager]);

  const handleFilterChange = useCallback(
    (filterType: FilterType) => {
      if (!imageFilterService) {
        return;
      }

      imageFilterService.setFilter(viewportId, filterType);
      setSelectedFilter(filterType);

      // Trigger viewport re-render
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
    <div className="flex flex-col space-y-2 p-2">
      <div className="grid grid-cols-1 gap-2">
        {filterOptions.map(option => (
          <button
            key={option.value}
            onClick={() => handleFilterChange(option.value)}
            className={`
              flex items-center justify-between px-4 py-2.5 rounded
              transition-colors duration-150
              ${
                selectedFilter === option.value
                  ? 'bg-primary-main text-black'
                  : 'bg-secondary-dark text-white hover:bg-secondary-light'
              }
            `}
          >
            <span className="text-sm font-medium">{option.label}</span>
            {selectedFilter === option.value && (
              <Icons.Checked className="w-4 h-4" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
