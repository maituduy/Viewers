# TỔNG QUAN CÁC FUNCTION CHÍNH

## 1. COLORBAR (Thanh màu hiển thị colormap)

### Các hàm sử dụng:
- **OHIF Service:** `colorbarService.hasColorbar()`, `colorbarService.toggleColorbar()`
- **VTK.js:** `vtkColorMaps.getPresetByName()` 
- **Cornerstone:** Colormap data
- **Hook:** `useViewportRendering()` → `hasColorbar`, `toggleColorbar`, `colorbarPosition`

### Luồng hoạt động:
1. User click toggle colorbar → `toggleColorbar(viewportId)`
2. Service bật/tắt colormap rendering
3. VTK.js cung cấp preset ('hsv', 'hot_iron', 'rainbow', v.v.)
4. OHIF render UI colorbar

**Xử lý:** OHIF (UI + Service) + VTK.js (colormap presets)

---

## 2. OPACITY (Điều chỉnh độ trong suốt volume)

### Các hàm sử dụng:
- **Cornerstone3D:** `viewport.setProperties({ colormap: { opacity } }, volumeId)`, `viewport.render()`
- **VTK.js:** `volumeProperty.getScalarOpacity()`, `opacityFunc.addPoint()`, `opacityFunc.getNodeValue()`
- **OHIF Hook:** `useViewportRendering()` → `opacity`, `setOpacity`, `opacityLinear`

### Luồng hoạt động:
1. User drag opacity slider (0-1)
2. `handleOpacityChange()` gọi `setOpacity(value)`
3. Gọi `viewport.setProperties({ colormap: { opacity } }, volumeId)`
4. Cornerstone3D render với opacity mới
5. VTK.js tính toán opacity transfer function

**Xử lý:** Cornerstone3D (setProperties + render) + VTK.js (opacity function)

---

## 3. DATA OVERLAY (Hiển thị thông tin metadata lên viewport)

### Các hàm sử dụng:
- **OHIF Components:** `ViewportOverlay`, `CustomizableViewportOverlay`
- **Cornerstone Events:** `CAMERA_MODIFIED`, `VOI_MODIFIED`, `VIEWPORT_NEW_IMAGE_SET`

### Luồng hoạt động:
1. Viewport load → OHIF render `CustomizableViewportOverlay`
2. Lắng nghe Cornerstone events (zoom, W/L change, image set change)
3. Khi event fire → cập nhật overlay metadata (topLeft, topRight, bottomLeft, bottomRight)
4. OHIF tự xử lý UI render (không dùng Cornerstone render)

**Xử lý:** OHIF tự xử lý hoàn toàn (Cornerstone chỉ cung cấp events)

---

## 4. FOREGROUND OVERLAY (Chồng hình CT + PT)

### Các hàm sử dụng:
- **OHIF Commands:** `addDisplaySetAsLayer()`, `removeDisplaySetLayer()`
- **OHIF Utils:** `configureViewportForLayerAddition()`, `createColormapOverlayDisplaySetOptions()`
- **OHIF Service:** `viewportGridService.getDisplaySetsUIDsForViewport()`, `hangingProtocolService.getViewportsRequireUpdate()`
- **Cornerstone3D:** `viewport.setVolumes()`, `viewport.setProperties()`, `viewport.render()`
- **VTK.js:** Rendering + opacity blending

### Luồng hoạt động:

**Thêm PT lên CT:**
```
1. User click "+ Foreground" → dropdown hiện PT options
2. User chọn PT display set → `handleAddDisplaySetAsLayer(ptDisplaySetUID)`
3. Run command `addDisplaySetAsLayer`:
   - Get current CT UUID
   - Add PT UUID → ['ctUUID', 'ptUUID']
   - Validate: `canAddDisplaySetToViewport()`
4. Call `configureViewportForLayerAddition()`:
   - Set viewport.displaySetInstanceUIDs = ['ctUUID', 'ptUUID']
   - Set viewport.viewportType = 'volume' (multi-volume)
   - Create displaySetOptions:
     * Index 0 (CT): {} ← no colormap
     * Index 1 (PT): { colormap: { name: 'hsv', opacity: 0.9 } }
5. Run `setDisplaySetsForViewports` command
6. CornerstoneViewportService:
   - Load 2 volumes (CT + PT)
   - Set colormap + opacity cho PT
   - Render composite image (CT background + PT overlay)
```

**Xóa PT:**
```
1. User click "Remove" button
2. Run command `removeDisplaySetLayer`:
   - Filter out PT UUID → ['ctUUID']
   - Reset displaySetOptions
3. Render with only CT
```

**Xử lý:** 
- OHIF (UI + commands + config)
- Cornerstone3D (multi-volume loading + rendering)
- VTK.js (opacity blending)

---

## TÓM TẮT

| Feature | OHIF | Cornerstone3D | VTK.js |
|---------|------|---------------|--------|
| **Colorbar** | ✅ Toggle UI | Colormap data | ✅ Presets |
| **Opacity** | ✅ Slider UI | ✅ setProperties | ✅ OpacityFunc |
| **Data Overlay** | ✅ UI render | Events only | ❌ |
| **Foreground** | ✅ Commands + Config | ✅ Multi-volume | ✅ Blending |
