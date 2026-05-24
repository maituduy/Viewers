# 3D Blend Mode Dev Spec

## Mục tiêu

Chuẩn hóa luồng 3D rendering mode trong OHIF theo đúng ý nghĩa projection mode của Cornerstone3D:

- `VR` = composite volume rendering
- `MIP` = maximum intensity projection
- `MinIP` = minimum intensity projection
- `AVG` = average intensity projection

Mục tiêu chính là tách rõ giữa:

- `Rendering Method`: thuật toán tổng hợp tia của volume actor
- `Rendering Preset`: preset transfer function / shading / lighting

Mục tiêu phụ:

- user nhìn vào UI là hiểu ngay mode nào đang là projection mode, mode nào là preset look
- đổi mode phải có hiệu lực ngay trên viewport hiện tại
- behavior phải bám sát pattern ở example Cornerstone3D, đặc biệt `petCt`, `mipJumpToClick`, `cursor3D`

## Hiện trạng

Trước khi có thay đổi, OHIF đang có menu 3D preset trong `WindowLevelActionMenu`, nhưng preset này chỉ đổi profile render, không phải đổi blend mode projection.

Các example chuẩn bên Cornerstone3D, như `petCt`, dùng pattern sau để tạo MIP projection:

- set `blendMode` thành `BlendModes.MAXIMUM_INTENSITY_BLEND`
- set `slabThickness` đủ lớn, thường lấy theo đường chéo volume
- set transfer function riêng cho PET/CT nếu cần

Quan sát quan trọng từ Cornerstone3D:

- MIP đúng nghĩa không chỉ là đổi một label trong UI
- viewport phải chuyển sang `BlendModes.MAXIMUM_INTENSITY_BLEND`
- nếu slab thickness thấp, projection sẽ bị mất ý nghĩa hoặc nhìn gần giống 3D composite thường
- `VR` là composite rendering, không phải một preset MIP ngược lại

## Định nghĩa nghiệp vụ

### Rendering Method

Là mode điều khiển cách renderer tổng hợp pixel dọc theo tia nhìn.

- `VR`: composite volume rendering
- `MIP`: maximum intensity projection
- `MinIP`: minimum intensity projection
- `AVG`: average intensity projection

### Rendering Preset

Là preset điều khiển appearance của volume, ví dụ:

- transfer function
- scalar opacity
- gradient opacity
- shading
- ambient/diffuse/specular

Hai nhóm này không được gộp chung về mặt UX lẫn code path.

## Phạm vi yêu cầu

### 1. UI

Thêm một mục mới trong menu 3D:

- Label: `Rendering Method`
- Options: `VR`, `MIP`, `MinIP`, `AVG`

Mục này chỉ hiển thị khi viewport là 3D volume viewport.

### 1.1 Placement trong menu

Mục `Rendering Method` phải nằm trong nhóm 3D display options, ngang cấp với:

- `Rendering Presets`
- `Rendering Options`

Không nhét vào nhóm window-level 2D để tránh người dùng nhầm đó là 2D VOI preset.

### 2. Hành vi

Khi chọn từng mode:

- `VR`
  - Blend mode: `COMPOSITE`
  - Reset slab thickness về mặc định
- `MIP`
  - Blend mode: `MAXIMUM_INTENSITY_BLEND`
  - Set slab thickness lớn theo full-volume diagonal
- `MinIP`
  - Blend mode: `MINIMUM_INTENSITY_BLEND`
  - Set slab thickness lớn theo full-volume diagonal
- `AVG`
  - Blend mode: `AVERAGE_INTENSITY_BLEND`
  - Set slab thickness lớn theo full-volume diagonal

### 2.1 Hành vi khi đổi mode

Khi user chọn một item mới, hệ thống phải làm theo thứ tự:

1. resolve viewport hiện tại
2. map lựa chọn UI sang `BlendModes`
3. set blend mode trên viewport
4. set slab thickness tương ứng
5. render lại viewport
6. cập nhật state active trong menu

Nếu bước 1-2 không resolve được viewport hoặc không có actor phù hợp thì no-op và log nhẹ, không crash UI.

### 3. Trạng thái active

Khi mở menu lại, item đang active phải phản ánh đúng blend mode hiện tại của viewport.

### 3.1 Quy tắc xác định active state

- `BlendModes.COMPOSITE` -> active `VR`
- `BlendModes.MAXIMUM_INTENSITY_BLEND` -> active `MIP`
- `BlendModes.MINIMUM_INTENSITY_BLEND` -> active `MinIP`
- `BlendModes.AVERAGE_INTENSITY_BLEND` -> active `AVG`

Nếu blend mode không đọc được hoặc không nằm trong mapping trên thì default về `VR`.

### 4. Áp dụng render ngay

Sau khi đổi mode, viewport phải render lại ngay.

Không cần user bấm thêm Apply.

## Implementation Notes

### 0. Recommended code path

UI component nên đi trực tiếp tới viewport runtime API, thay vì tạo command riêng nếu command chưa được đăng ký ổn định ở current context.

Ưu tiên:

- `cornerstoneViewportService.getCornerstoneViewport(viewportId)`
- `viewport.setBlendMode(...)`
- `viewport.setSlabThickness(...)`
- `viewport.render()`

### 0.1 Vì sao không phụ thuộc vào command ở bước đầu

Trong OHIF runtime, command registry có thể khác nhau theo context, khiến click menu có thể báo `Command not found in current context` nếu command chưa được register đúng layer.

Vì vậy, với behavior cốt lõi của 3D blend mode, direct viewport API là đường ổn định hơn.

### Đổi blend mode

Nên gọi trực tiếp API của viewport:

- `viewport.setBlendMode(...)`
- `viewport.render()`

Nếu cần tương thích runtime khác nhau, có thể sync thêm actor mapper blend mode, nhưng đây chỉ là fallback.

### 0.2 Mapping kỹ thuật

| UI | Cornerstone blend mode |
| --- | --- |
| `VR` | `BlendModes.COMPOSITE` |
| `MIP` | `BlendModes.MAXIMUM_INTENSITY_BLEND` |
| `MinIP` | `BlendModes.MINIMUM_INTENSITY_BLEND` |
| `AVG` | `BlendModes.AVERAGE_INTENSITY_BLEND` |

### 0.3 Slab thickness strategy

Khi mode là projection mode (`MIP`, `MinIP`, `AVG`), slab thickness nên là full-volume diagonal để giống chuẩn demo Cornerstone3D.

Khi mode là `VR`, slab thickness phải reset về minimum/default để tránh composite bị ảnh hưởng bởi slab dày còn sót lại.

### Slab thickness

Với MIP/MinIP/AVG, slab thickness nên lấy từ kích thước volume thực tế:

$$
\sqrt{(d_x s_x)^2 + (d_y s_y)^2 + (d_z s_z)^2}
$$

Trong đó:

- `d_x, d_y, d_z` là dimensions
- `s_x, s_y, s_z` là spacing

Mục đích là bao phủ toàn bộ volume để projection thật sự có ý nghĩa.

### 0.4 Actor / viewport consistency

Một số runtime path có thể giữ state blend mode ở mapper/actor layer. Nếu viewport API và actor state lệch nhau, UI sẽ bị đổi nhưng render nhìn không đổi hoặc đổi chậm.

Vì vậy khi implement, cần đảm bảo:

- viewport state được set trước
- nếu runtime không update mapper ngay, sync thêm trên actor mapper như fallback
- không để active state trong menu phụ thuộc vào state cũ của component local בלבד

### VR reset

Khi quay về `VR`, cần:

- reset blend mode về composite
- reset slab thickness về minimum/default

Nếu viewport có API `resetSlabThickness()`, ưu tiên gọi API này; nếu không có thì set minimum slab thickness theo default constant.

## Design Rationale

### Vì sao không coi preset MIP là MIP projection

Trong OHIF, preset 3D thường là cấu hình transfer function/shading. Nó thay đổi cách vật liệu hiển thị, nhưng không nhất thiết đổi thuật toán projection.

MIP projection chuẩn phải đổi `blendMode` của viewport/actor.

### Vì sao cần slab thickness lớn

Nếu chỉ đổi blend mode mà slab quá mỏng, hiệu ứng MIP/MinIP sẽ không khác biệt rõ hoặc không đúng tinh thần của projection mode.

### Vì sao vẫn giữ Rendering Presets riêng

Preset và projection solve hai bài toán khác nhau:

- preset: ảnh trông như thế nào
- blend mode: ánh xạ voxel dọc theo tia nhìn như thế nào

Nếu gộp hai thứ này vào một UI item, user sẽ rất khó đoán behavior và khó debug khi output hình ảnh không như mong đợi.

### Vì sao chọn full-volume diagonal

Cornerstone3D examples như `petCt` và `mipJumpToClick` đều dùng slab đủ lớn để cover toàn volume. Cách này có ưu điểm:

- projection nhất quán giữa các orientation
- không phụ thuộc vào trường hợp slab hiện tại người dùng đang kéo dở
- phù hợp với intuition "MIP toàn volume"

## Edge Cases

- Viewport không phải 3D volume viewport thì không hiển thị mục này.
- Nếu `setBlendMode` không có sẵn ở runtime nào đó, cần fallback an toàn hoặc no-op có log.
- Nếu volume metadata chưa sẵn sàng để tính slab thickness, fallback về default slab thickness.
- Nếu viewport có nhiều actors, blend mode nên áp dụng nhất quán cho toàn bộ actor liên quan.
- Nếu volume là fusion viewport nhiều volume, cần xác định rõ actor nào là target của blend mode. Nếu runtime chỉ có một volume actor chính thì áp dụng cho actor chính đó.
- Nếu cùng một viewport đang có interaction tool can thiệp slab thickness, selection mode vẫn phải phản ánh blend mode hiện tại sau khi tool update.
- Nếu user chọn projection mode rồi chuyển viewport hoặc display set, active state phải refresh theo viewport mới.

## Data Flow

Luồng dữ liệu mong muốn:

`menu click` -> `resolve viewport` -> `map UI method to BlendModes` -> `setBlendMode` -> `setSlabThickness` -> `render` -> `update active state`

Không nên có luồng ngược kiểu:

`menu click` -> `update local state only` -> chờ effect khác render viewport

vì sẽ làm người dùng thấy UI đổi nhưng hình chưa đổi ngay.

## Interaction Model

### Khi mở menu

- đọc blend mode hiện tại từ viewport
- map thành item active

### Khi click item đang active

- vẫn cho phép re-apply mode nếu cần
- nhưng nên tránh render thừa nếu state không đổi, trừ khi cần ép sync lại slab thickness

### Khi click mode khác

- apply ngay
- đóng hoặc giữ menu theo pattern hiện tại của UI shell, không ép thay đổi UX shell nếu chưa có yêu cầu riêng

## Validation Plan

### Manual checks

1. Mở viewport 3D có volume thực.
2. Chọn `VR` và xác nhận render composite bình thường.
3. Chọn `MIP` và xác nhận projection sáng rõ vùng cường độ cao nhất.
4. Chọn `MinIP` và xác nhận projection ưu tiên voxel cường độ thấp nhất.
5. Chọn `AVG` và xác nhận output mượt hơn MIP/MinIP.
6. Đổi qua lại vài lần để chắc state active và render không lệch nhau.

### Regression checks

- menu 2D không bị ảnh hưởng
- Rendering Presets vẫn hoạt động riêng
- Volume Rendering Quality, Lighting, Shade vẫn giữ nguyên behavior
- không còn warning về command thiếu context trong luồng render method

### Developer sanity checks

- log blend mode hiện tại trước và sau khi đổi để confirm state sync
- nếu có nhiều actors, inspect actor entries xem blend mode đã được set đồng nhất chưa

## Acceptance Criteria

1. Người dùng thấy menu `Rendering Method` trong 3D.
2. Chọn `MIP` làm viewport chuyển sang maximum intensity projection.
3. Chọn `MinIP` làm viewport chuyển sang minimum intensity projection.
4. Chọn `AVG` làm viewport chuyển sang average intensity projection.
5. Chọn `VR` làm viewport trở về composite rendering.
6. Khi đổi mode, effect phải thấy ngay mà không cần reload.
7. Không còn nhầm lẫn giữa `Rendering Preset` và `Rendering Method`.
8. Behavior MIP/MinIP/AVG phải tương thích với pattern Cornerstone3D example, tức projection mode thật sự chứ không chỉ đổi màu hay preset look.

## Related Files

- [cmpr-ohif-viewer/extensions/cornerstone/src/components/WindowLevelActionMenu/WindowLevelActionMenu.tsx](../extensions/cornerstone/src/components/WindowLevelActionMenu/WindowLevelActionMenu.tsx)
- [cmpr-ohif-viewer/extensions/cornerstone/src/components/WindowLevelActionMenu/VolumeRenderingMethods.tsx](../extensions/cornerstone/src/components/WindowLevelActionMenu/VolumeRenderingMethods.tsx)
- [cmpr-ohif-viewer/extensions/cornerstone/src/components/WindowLevelActionMenu/VolumeRenderingPresets.tsx](../extensions/cornerstone/src/components/WindowLevelActionMenu/VolumeRenderingPresets.tsx)
- [cmpr-ohif-viewer/extensions/cornerstone/src/components/WindowLevelActionMenu/VolumeRenderingOptions.tsx](../extensions/cornerstone/src/components/WindowLevelActionMenu/VolumeRenderingOptions.tsx)
- [Cornerstone3D petCt example](https://github.com/cornerstonejs/cornerstone3D/blob/main/packages/tools/examples/petCt/index.ts)
- [Cornerstone3D BlendModes enum](https://github.com/cornerstonejs/cornerstone3D/blob/main/packages/core/src/enums/BlendModes.ts)

## Ghi chú cho dev tiếp theo

Nếu cần đồng bộ hành vi với các example Cornerstone3D như `petCt`, nên ưu tiên đặt blend mode và slab thickness ở layer viewport/actor, không đặt vào preset UI.

Nếu sau này muốn mở rộng, có thể tách thêm:

- `Rendering Method` cho projection mode
- `Rendering Preset` cho look preset
- `Slab Thickness` cho projection depth

để người dùng điều khiển từng trục độc lập.