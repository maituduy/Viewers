# Tài liệu kỹ thuật Filter cho Cornerstone

## 1. Mục tiêu
- Mô tả cách filter ảnh đang hoạt động trong extension Cornerstone.
- Giải thích luồng xử lý hiện tại theo hướng native render-pass của Cornerstone.
- Ghi rõ hành vi stack filter: mỗi lần click là thêm 1 layer vào queue, không thay thế layer trước.
- Làm tài liệu tham chiếu cho dev khi cần mở rộng, debug, hoặc tinh chỉnh filter.

## 2. Phạm vi
Tài liệu này áp dụng cho feature filter trong viewport của extension Cornerstone, gồm:
- Sharpen
- Blur
- Emboss
- Edges
- None / Clear all

## 3. Kiến trúc hiện tại
### 3.1 Luồng tổng quát
- UI chọn filter nằm ở menu Window/Level.
- User click vào một filter để thêm 1 layer mới vào stack của viewport.
- Service lưu queue filter theo từng viewportId.
- Khi viewport render, service dựng một render-pass chain theo đúng thứ tự queue.
- Cornerstone/VTK xử lý toàn bộ effect ở pipeline render, không dùng canvas post-process hay worker riêng.

### 3.2 Thành phần chính
- `extensions/cornerstone/src/components/WindowLevelActionMenu/ImageFilter.tsx`
  - Hiển thị UI filter.
  - Hiển thị danh sách filter đã áp dụng theo thứ tự.
  - Cho phép thêm filter mới và xóa từng layer bằng nút `x`.

- `extensions/cornerstone/src/services/ImageFilterService/ImageFilterService.ts`
  - Lưu state filter theo viewport.
  - Dựng stack filter theo queue click.
  - Tạo render-pass chain cho sharpen, blur, emboss, edges.
  - Patch viewport instance để hỗ trợ các property custom.

- `extensions/cornerstone/src/Viewport/OHIFCornerstoneViewport.tsx`
  - Không còn xử lý filter hậu kỳ bằng canvas.
  - Viewport render theo pipeline native của Cornerstone.

## 4. Hành vi chức năng
### 4.1 Quy tắc stacking
- Mỗi lần click một filter trong UI sẽ thêm 1 layer mới vào queue.
- Click lại cùng filter sẽ thêm lại filter đó thêm 1 lần nữa.
- Thứ tự stack được giữ nguyên theo thứ tự click.
- Ví dụ:
  - `emboss -> blur -> blur -> edges`
  - Kết quả: 4 pass được áp lần lượt lên nhau theo đúng thứ tự trên.

### 4.2 Xóa filter
- Nút `x` ở từng item trong danh sách Applied Filters sẽ xóa đúng layer theo vị trí.
- `Clear All` xóa toàn bộ queue của viewport.
- `none` dùng để reset stack.

### 4.3 Ngưỡng mặc định
Giá trị mặc định hiện tại được tăng nhẹ để effect dễ thấy hơn:
- sharpening: `1.6`
- smoothing: `1.6`
- embossing: `1.8`
- edgeEnhancement: `1.8`

### 4.4 Quy tắc render
- Sharpen và blur dùng render-pass native của Cornerstone.
- Emboss và edges dùng render-pass custom theo cùng cơ chế VTK convolution.
- Các pass được build thành một chain duy nhất để đảm bảo filter sau thật sự chạy tiếp trên output của filter trước.

## 5. API service
### 5.1 Public methods chính
File: `extensions/cornerstone/src/services/ImageFilterService/ImageFilterService.ts`

- `toggleFilter(viewportId: string, filterType: FilterType): void`
  - Thêm 1 layer filter mới vào stack.
  - Nếu `filterType === 'none'` thì xóa toàn bộ stack.

- `removeFilterAt(viewportId: string, index: number): void`
  - Xóa 1 layer cụ thể theo index trong queue.

- `getActiveFilters(viewportId: string): FilterType[]`
  - Trả về queue filter hiện tại của viewport.

- `setNativeFilterSettings(viewportId: string, settings: Partial<NativeFilterSettings>): void`
  - Cập nhật ngưỡng của các filter native/custom.

- `clearAllFilters(viewportId: string): void`
  - Xóa toàn bộ filter stack của viewport.

### 5.2 State structure
Mỗi viewport lưu:
- `activeFilters: FilterType[]`
- `native: NativeFilterSettings`

Ví dụ:
```typescript
{
  activeFilters: ['emboss', 'blur', 'blur', 'edges'],
  native: {
    sharpening: 1,
    smoothing: 1.6,
    embossing: 1.8,
    edgeEnhancement: 1.8,
  }
}
```

## 6. Render-pass model
### 6.1 Nguyên tắc
- Không tạo nhiều pass rời không liên kết.
- Không cộng dồn intensity thành một giá trị tổng duy nhất.
- Phải tạo chain pass nối tiếp để filter sau nhận output của filter trước.

### 6.2 Cách dựng chain
- Bắt đầu từ `vtkForwardPass`.
- Với mỗi filter trong `activeFilters`, tạo một `vtkConvolution2DPass` tương ứng.
- Gắn delegate của pass mới vào pass chain hiện tại.
- Pass mới trở thành head của chain.
- Kết quả cuối cùng là một pipeline xâu chuỗi đúng thứ tự click.

### 6.3 Ý nghĩa thực tế
Nếu stack là:
- `emboss`
- `blur`
- `blur`
- `edges`

thì pipeline render sẽ đi qua 4 bước riêng biệt theo đúng sequence này, thay vì chỉ lấy pass cuối.

## 7. UI behavior
### 7.1 Màn hình filter
File: `extensions/cornerstone/src/components/WindowLevelActionMenu/ImageFilter.tsx`

- Danh sách filter được render thành button.
- Khi click filter:
  - Gọi service để append filter vào stack.
  - Refresh state UI.
  - Trigger viewport render lại.
- Danh sách Applied Filters hiển thị đúng thứ tự queue.

### 7.2 Kỳ vọng UX
- User nhìn thấy rõ filter nào đang active.
- User có thể áp nhiều lần cùng một filter.
- User có thể gỡ từng layer mà không làm mất các layer còn lại.

## 8. Tệp liên quan
- `extensions/cornerstone/src/services/ImageFilterService/ImageFilterService.ts`
- `extensions/cornerstone/src/services/ImageFilterService/index.ts`
- `extensions/cornerstone/src/components/WindowLevelActionMenu/ImageFilter.tsx`
- `extensions/cornerstone/src/Viewport/OHIFCornerstoneViewport.tsx`
- `extensions/cornerstone/src/index.tsx`

## 9. Ghi chú kỹ thuật
- Feature này phụ thuộc vào render-pass pipeline của Cornerstone/VTK.
- Nếu viewport không hỗ trợ `setProperties` hoặc `getRenderPasses`, service sẽ bỏ qua một cách an toàn.
- Khi thay đổi kernel hoặc intensities, nên test theo từng viewport type để đảm bảo visual output không bị override bởi pipeline khác.

## 10. Checklist cho dev khi chỉnh filter
- [ ] Kiểm tra queue `activeFilters` có đúng thứ tự click không.
- [ ] Kiểm tra render-pass chain có build theo thứ tự queue không.
- [ ] Kiểm tra filter cùng loại có được thêm nhiều lần không.
- [ ] Kiểm tra nút `x` có xóa đúng layer theo index không.
- [ ] Kiểm tra `Clear All` có reset toàn bộ stack không.
- [ ] Kiểm tra ngưỡng mặc định có đủ nhìn thấy nhưng không quá gắt.

## 11. Kết luận
Filter hiện tại đã chuyển sang mô hình native render-pass có stack theo queue. Đây là hướng đúng để dev tiếp tục mở rộng thêm filter mới, tune kernel, hoặc thêm preset mà không cần quay lại pipeline canvas/worker cũ.
