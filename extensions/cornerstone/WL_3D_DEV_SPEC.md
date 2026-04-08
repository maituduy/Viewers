# WL 3D Dev Spec

## 1. Mục tiêu
- Ổn định hành vi Window/Level trong viewport 3D.
- Tránh lỗi first-drag jump (nhảy từ mức hiện tại sang WW/WC rất lớn).
- Giữ tốc độ kéo WL 3D mềm hơn 2D (giảm 50%).
- Đồng bộ Shift opacity theo WL để người dùng không cần chỉnh Shift bằng tay.

## 2. Phạm vi file
- `extensions/cornerstone/src/initCornerstoneTools.js`
- `extensions/cornerstone/src/commandsModule.ts`
- `extensions/cornerstone/src/components/WindowLevelActionMenu/VolumeShift.tsx`
- `extensions/cornerstone/src/services/ViewportService/CornerstoneViewportService.ts`

## 3. Khái niệm và biến chính
Trong `patchWindowLevelToolFor3D`:
- `WL_3D_DELTA_CLAMP = 24`
- `WL_3D_WW_MULTIPLIER = 2.0`
- `WL_3D_WC_MULTIPLIER = 2.0`
- `WL_3D_DRAG_SCALE = 0.5`  <-- giảm tốc độ kéo 50%
- `WL_3D_WIDE_BASELINE_THRESHOLD = 5000`
- `WL_3D_EMERGENCY_BASELINE_WW = 2000`
- `WL_3D_AUTO_SHIFT_FACTOR = 1.0`
- `WL_3D_AUTO_SHIFT_MAX_DELTA = 30`

## 4. Sơ đồ ASCII (append theo yêu cầu)
```text
[Kéo chuột WL 3D]
        |
        v
[Xác định baseline VOI]
  current -> stored -> actor -> displaySet -> preset
        |
        v
[Kiểm tra baseline quá rộng]
  có fallback hẹp hơn -> dùng fallback
  không có fallback -> emergency WW=2000
        |
        v
[Áp delta kéo đã clamp]
  WW/WC = WW/WC + delta * DRAG_SCALE(0.5)
        |
        v
[Tạo nextRange]
        |
        v
[Auto Shift theo delta WindowCenter]
  shiftDelta có clamp mỗi event
        |
        v
[Cập nhật baseline runtime]
  __ohifWL3DBaselineByVolumeId
  __ohifWL3DFallbackVoiRange
        |
        v
[Render viewport]
```

## 5. Pipeline WL 3D (tool drag)
```text
mouse drag (deltaPointsCanvas)
  -> detect viewport 3D
  -> lấy baseline VOI ưu tiên:
       currentVoiRange
       -> stored baseline by volume
       -> actor range
       -> displaySet VOI (metadata/preset)
       -> preset by modality
  -> nếu baseline quá rộng (full range) và có fallback hẹp hơn:
       thay baseline bằng fallback
  -> nếu baseline quá rộng và không có fallback:
       emergency clamp WW=2000 quanh center hiện tại
  -> convert baseline range -> (windowWidth, windowCenter)
  -> apply delta đã clamp * drag scale 0.5
  -> convert lại về low/high range
  -> auto shift opacity theo delta windowCenter (có clamp)
  -> cập nhật stored baseline trên viewport
  -> return nextRange
```

## 6. Cơ chế giảm tốc kéo WL 3D
### 6.1 Tool path
- Trong `initCornerstoneTools.js`, delta drag được nhân thêm `WL_3D_DRAG_SCALE = 0.5`.
- Công thức:
  - `windowWidth += deltaX * WL_3D_WW_MULTIPLIER * 0.5`
  - `windowCenter += deltaY * WL_3D_WC_MULTIPLIER * 0.5`

### 6.2 Command path
- Trong `setViewportWindowLevel` (`commandsModule.ts`), với 3D:
  - Tính delta với current VOI.
  - Clamp mỗi event: width `120`, center `80`.
  - Nếu không phải preset jump lớn, apply hệ số 0.5:
    - `windowWidthNum = current + boundedWidthDelta * 0.5`
    - `windowCenterNum = current + boundedCenterDelta * 0.5`

### 6.3 Panel path
- Trong `ViewportWindowLevel.tsx`, 3D path dùng `DRAG_SCALE_3D = 0.5` với bounded delta.

## 7. Baseline và anti-jump
- Baseline luôn ưu tiên VOI hiện tại của viewport/volume.
- Dùng fallback chain khi cần để tránh lấy nhầm full scalar range.
- Có memory trên viewport:
  - `__ohifWL3DBaselineByVolumeId`
  - `__ohifWL3DFallbackVoiRange`
- Sau mỗi cập nhật WL, baseline được cập nhật lại để tránh snap-back ngẫu nhiên.

## 8. Auto Shift theo WL 3D
- Mục tiêu: đổi WL thì Shift opacity tự chạy để rõ mạch/xương hơn.
- Tool path và command path đều có auto-shift.
- Shift được tính theo chênh lệch `windowCenter` và clamp mỗi event (`max 30`).
- Slider Shift trong UI đồng bộ lại theo giá trị `viewport.shiftedBy` qua event `VOI_MODIFIED`.

## 9. Edge cases đã xử lý
- Study có baseline rộng bất thường (~6000) -> fallback hẹp hơn.
- Study có baseline rộng nhưng hợp lệ -> không ép fallback nếu fallback không hẹp hơn đáng kể.
- Trường hợp không tìm thấy fallback -> emergency baseline WW=2000.

## 10. Troubleshooting nhanh
- Nếu WL 3D bị jump ngay lần đầu:
  - Check `currentVoiRange` có full-range không.
  - Check displaySet metadata có `WindowCenter/WindowWidth` không.
- Nếu kéo bị back về giá trị cũ:
  - Check baseline storage có được cập nhật mỗi event không.
  - Check điều kiện override wide baseline có quá aggressive không.
- Nếu Shift không đồng bộ UI:
  - Check `VolumeShift.tsx` listener `VOI_MODIFIED`.

## 11. Checklist regression
- [ ] Kéo WL 3D bắt đầu từ giá trị đang hiển thị (không jump).
- [ ] Tốc độ kéo 3D mềm hơn (0.5) trên tool/command/panel.
- [ ] Preset WL lớn vẫn áp dụng nhanh, không bị soft clamp sai.
- [ ] Shift tự động đổi theo WL 3D.
- [ ] Slider Shift cập nhật đúng khi kéo WL.
- [ ] Không crash viewport 3D do filter pipeline.
