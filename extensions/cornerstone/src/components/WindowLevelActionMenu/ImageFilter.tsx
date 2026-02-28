import React, { ReactElement, useCallback, useEffect, useState } from 'react';
import { Icons } from '@ohif/ui-next';
import { FilterType } from '../../services/ImageFilterService';
import { useSystem } from '@ohif/core';
import {
  measureFilterPrecision,
  type FilterKernelName,
  type PrecisionReport,
} from '../../utils/filterPrecisionAnalysis';

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
  const [report, setReport] = useState<PrecisionReport | null>(null);
  const [measuring, setMeasuring] = useState(false);

  useEffect(() => {
    if (imageFilterService) {
      const currentFilter = imageFilterService.getFilter(viewportId);
      setSelectedFilter(currentFilter);
    }
  }, [imageFilterService, viewportId]);

  const handleFilterChange = useCallback(
    (filterType: FilterType) => {
      if (!imageFilterService) {
        return;
      }

      imageFilterService.setFilter(viewportId, filterType);
      setSelectedFilter(filterType);
      setReport(null);

      // Trigger viewport re-render
      const { cornerstoneViewportService } = servicesManager.services;
      const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
      if (viewport) {
        viewport.render();
      }
    },
    [imageFilterService, viewportId, servicesManager]
  );

  const handleMeasure = useCallback(() => {
    if (selectedFilter === 'none') return;

    const { cornerstoneViewportService } = servicesManager.services;
    const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
    if (!viewport) return;

    const element = viewport.element as HTMLElement;
    const canvas = element?.querySelector('canvas') as HTMLCanvasElement;
    if (!canvas) return;

    setMeasuring(true);
    setReport(null);

    // Run after current render frame
    requestAnimationFrame(() => {
      const result = measureFilterPrecision(viewportId, selectedFilter as FilterKernelName, canvas);
      setReport(result);
      setMeasuring(false);
    });
  }, [selectedFilter, viewportId, servicesManager]);

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

      {/* Precision measurement — only shown when a filter is active */}
      {selectedFilter !== 'none' && (
        <div className="mt-2 border-t border-secondary-light pt-2">
          <button
            onClick={handleMeasure}
            disabled={measuring}
            className="w-full px-3 py-2 rounded text-xs font-medium bg-secondary-dark text-white hover:bg-secondary-light disabled:opacity-50 transition-colors"
          >
            {measuring ? 'Đang đo...' : '📊 Đo độ lệch chuẩn (16-bit vs 8-bit)'}
          </button>

          {report && (
            <div className="mt-2 rounded bg-black/30 p-2 text-xs text-white space-y-1">
              <div className="font-semibold text-yellow-300 mb-1">
                Kết quả — filter: {report.filterType}
              </div>

              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                <span className="text-gray-400">Input raw:</span>
                <span className="font-mono">{report.inputBitDepth}</span>

                <span className="text-gray-400">Kích thước:</span>
                <span className="font-mono">
                  {report.width} × {report.height} ({report.pixelCount.toLocaleString()} px)
                </span>

                <span className="text-gray-400">Mean abs error:</span>
                <span className={`font-mono ${report.meanAbsError > 1 ? 'text-red-400' : 'text-green-400'}`}>
                  {report.meanAbsError.toFixed(4)} / 255
                </span>

                <span className="text-gray-400">Std deviation:</span>
                <span className={`font-mono ${report.stdDev > 1 ? 'text-red-400' : 'text-green-400'}`}>
                  {report.stdDev.toFixed(4)} / 255
                </span>

                <span className="text-gray-400">Max error:</span>
                <span className={`font-mono ${report.maxError > 5 ? 'text-red-400' : 'text-yellow-300'}`}>
                  {report.maxError.toFixed(4)} / 255
                </span>

                <span className="text-gray-400">PSNR:</span>
                <span className={`font-mono ${report.psnr < 40 ? 'text-red-400' : 'text-green-400'}`}>
                  {report.psnr === Infinity ? '∞' : `${report.psnr.toFixed(2)} dB`}
                </span>
              </div>

              <div className="mt-1 text-gray-400 text-xs">
                {report.psnr >= 50
                  ? '✅ Xuất sắc — sai số cực nhỏ, không ảnh hưởng chẩn đoán'
                  : report.psnr >= 40
                  ? '✅ Tốt — PSNR ≥ 40 dB, đạt chuẩn ảnh y tế hiển thị'
                  : report.psnr >= 30
                  ? '⚠️ Chấp nhận được — có thể ảnh hưởng nhẹ ở vùng chi tiết cao'
                  : '❌ Kém — sai số lớn, cần xem lại pipeline filter'}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
