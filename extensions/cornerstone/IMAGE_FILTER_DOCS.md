# Image Filter — Tài liệu kỹ thuật

## Tổng quan

Tính năng Image Filter cho phép người dùng áp dụng bộ lọc hình ảnh thời gian thực lên viewport của OHIF Viewer. Quá trình xử lý được thực hiện hoàn toàn trên GPU thông qua WebGL (convolution kernel 3×3), không gây giật lag hay flash hình ảnh.

---

## Kiến trúc tổng thể

```
[App khởi động]
    └─ ImageFilterService được đăng ký vào OHIF service registry

[OHIFCornerstoneViewport.tsx mount]  ← React component bao mỗi viewport
    └─ Tạo global filterRenderer = new ViewportFilterRenderer(imageFilterService)

[Cornerstone kích hoạt element  (ELEMENT_ENABLED event)]
    └─ elementEnabledHandler()
        └─ filterRenderer.enableFilterRendering(viewportId, element)
            └─ Đăng ký listener IMAGE_RENDERED lên DOM element
               (filterType = 'none' → listener tồn tại nhưng không làm gì)

[Người dùng bấm nút filter trên UI — ImageFilter.tsx]
    └─ imageFilterService.setFilter(viewportId, 'sharpen')
    └─ viewport.render()

[Cornerstone render xong frame — IMAGE_RENDERED event]
    └─ listener của ViewportFilterRenderer chạy
        └─ imageFilterService.applyFilter(viewportId, canvas, 'sharpen')  ← WebGL
        └─ ctx.drawImage(filteredCanvas, 0, 0)  ← ghi đè canvas gốc

[OHIFCornerstoneViewport.tsx unmount]
    └─ filterRenderer.disableFilterRendering(viewportId, element)
        └─ Xóa listener IMAGE_RENDERED
        └─ imageFilterService.dispose(viewportId)  ← giải phóng WebGL resources
```

---

## Các file liên quan

| File | Vai trò |
|------|---------|
| `extensions/cornerstone/src/services/ImageFilterService/ImageFilterService.ts` | WebGL service — biên dịch shader, quản lý texture, thực thi convolution |
| `extensions/cornerstone/src/utils/ViewportFilterRenderer.ts` | Bridge — đăng ký listener Cornerstone, gọi service, ghi lên canvas |
| `extensions/cornerstone/src/Viewport/OHIFCornerstoneViewport.tsx` | React component viewport — khởi tạo filterRenderer, gắn/gỡ listener |
| `extensions/cornerstone/src/commandsModule.ts` | Cung cấp commands `setImageFilter`, `getImageFilter`, `clearImageFilter` |
| `extensions/cornerstone/src/components/WindowLevelActionMenu/ImageFilter.tsx` | UI component — 5 nút chọn filter |

---

## Các bộ lọc hỗ trợ

| FilterType | Tên hiển thị | Kernel 3×3 | Mô tả |
|------------|--------------|------------|-------|
| `none`     | None         | Identity `[0,0,0, 0,1,0, 0,0,0]` | Không lọc, bỏ qua WebGL |
| `sharpen`  | Sharpen      | `[0,-1,0, -1,5,-1, 0,-1,0]` | Làm sắc nét cạnh |
| `blur`     | Blur         | `[1/9 × 9]` | Làm mờ đồng đều (box blur) |
| `emboss`   | Emboss       | `[-2,-1,0, -1,1,1, 0,1,2]` | Hiệu ứng nổi 3D |
| `edges`    | Edges        | `[-1,-1,-1, -1,8,-1, -1,-1,-1]` | Phát hiện cạnh (Laplacian) |

---

## Chi tiết kỹ thuật

### 1. Vertex Shader

```glsl
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = vec2(a_texCoord.x, 1.0 - a_texCoord.y);
}
```

**Lưu ý quan trọng:** `1.0 - a_texCoord.y` là bắt buộc vì WebGL dùng hệ tọa độ bottom-left (gốc dưới trái), còn `canvas.getContext('2d').drawImage()` dùng hệ top-left. Nếu không flip Y, ảnh sẽ bị lộn ngược chiều dọc sau khi lọc.

### 2. Fragment Shader

```glsl
precision mediump float;

uniform sampler2D u_image;
uniform vec2 u_textureSize;
uniform float u_kernel[9];

varying vec2 v_texCoord;

void main() {
  vec2 onePixel = vec2(1.0) / u_textureSize;
  vec4 colorSum = vec4(0.0);

  for(int i = 0; i < 3; i++) {
    for(int j = 0; j < 3; j++) {
      vec2 offset = vec2(float(j - 1), float(i - 1)) * onePixel;
      colorSum += texture2D(u_image, v_texCoord + offset) * u_kernel[i * 3 + j];
    }
  }

  gl_FragColor = vec4(colorSum.rgb, 1.0);
}
```

Thực hiện tích chập (convolution) 3×3: với mỗi pixel, lấy màu của 9 pixel lân cận (bao gồm chính nó), nhân với hệ số tương ứng trong kernel rồi cộng lại.

### 3. Luồng đầy đủ từng bước

**Filter chỉ chạy sau khi người dùng bấm nút** — không tự động chạy khi viewport khởi tạo.

---

#### Bước 1 — App khởi động: Đăng ký Service

```
platform/app khởi động
    → OHIF service registry load tất cả services
    → ImageFilterService.REGISTRATION.create() được gọi
    → new ImageFilterService(servicesManager) tồn tại trong servicesManager.services.imageFilterService
    → filterState = {} (rỗng, chưa có viewport nào)
```

---

#### Bước 2 — Viewport mount: Tạo FilterRenderer (một lần duy nhất toàn app)

```
OHIFCornerstoneViewport.tsx render lần đầu
    → destructure imageFilterService từ servicesManager.services
    → kiểm tra: if (imageFilterService && !filterRenderer)
        → filterRenderer = new ViewportFilterRenderer(imageFilterService)
           (global variable, chỉ tạo 1 lần dù có nhiều viewport)
        → filterRenderer.eventListeners = new Map()  (rỗng)

* Lưu ý: filterRenderer là biến global module-level trong OHIFCornerstoneViewport.tsx,
  không phải per-component. Tất cả viewport dùng chung 1 instance.
```

---

#### Bước 3 — Cornerstone kích hoạt element: Đăng ký listener

```
Cornerstone gắn element vào rendering engine
    → fired: Enums.Events.ELEMENT_ENABLED
    → elementEnabledHandler(evt) chạy trong OHIFCornerstoneViewport.tsx

    Trong elementEnabledHandler:
        → toolGroupService.addViewportToToolGroup(...)
        → syncGroupService.addViewportToSyncGroup(...)
        → if (filterRenderer && element):
            → filterRenderer.enableFilterRendering(viewportId, element)

    Trong enableFilterRendering():
        → tạo renderHandler = (evt) => { applyFilterToCanvas(viewportId, element) }
        → element.addEventListener('CORNERSTONE_TOOLS_IMAGE_RENDERED', renderHandler)
        → lưu vào eventListeners.set(viewportId, [{event, handler}])

    Kết quả: Listener đã được gắn vào element,
             nhưng filterType mặc định = 'none'
             → mỗi lần IMAGE_RENDERED fire, handler chạy rồi return ngay
```

---

#### Bước 4 — Người dùng bấm nút filter

**Có 2 đường vào:**

**Đường A — Qua UI component ImageFilter.tsx (trực tiếp):**
```
Người dùng bấm nút "Sharpen" trong ImageFilter.tsx
    → handleFilterChange('sharpen') được gọi
        → imageFilterService.setFilter(viewportId, 'sharpen')
            → filterState[viewportId].filterType = 'sharpen'
            → broadcast FILTER_CHANGED event (cho các subscriber)
        → cornerstoneViewportService.getCornerstoneViewport(viewportId)
        → viewport.render()  ← yêu cầu Cornerstone render lại frame
```

**Đường B — Qua commandsManager (từ toolbar/keyboard shortcut):**
```
commandsManager.run('setImageFilter', { viewportId, filterType: 'sharpen' })
    → actions.setImageFilter() trong commandsModule.ts
        → imageFilterService.setFilter(targetViewportId, 'sharpen')
        → viewport.render()
```

---

#### Bước 5 — Cornerstone render frame và filter được áp dụng

```
viewport.render() trigger Cornerstone render pipeline
    → Cornerstone render xong pixel data lên <canvas>
    → fired: EVENTS.IMAGE_RENDERED (trước khi browser paint)

    → renderHandler() trong ViewportFilterRenderer chạy:
        → imageFilterService.getFilter(viewportId) → 'sharpen'
        → filterType !== 'none', tiếp tục...
        → canvas = element.querySelector('canvas')

    → imageFilterService.applyFilter(viewportId, canvas, 'sharpen'):

        [Lần đầu tiên cho viewport này]
            → filterState[viewportId].gl chưa có
            → initWebGL(viewportId, canvas):
                → tạo offscreen canvas (cùng width/height với sourceCanvas)
                → canvas.getContext('webgl', { preserveDrawingBuffer: true })
                → compileShader(VERTEX_SHADER, vertexShaderSource)
                → compileShader(FRAGMENT_SHADER, fragmentShaderSource)
                → gl.createProgram() → gl.linkProgram()
                → tạo positionBuffer (quad -1,-1 đến 1,1)
                → tạo texCoordBuffer (0,0 đến 1,1)
                → gl.createTexture() + texParameteri (CLAMP_TO_EDGE, LINEAR)
                → gl.enableVertexAttribArray cho a_position, a_texCoord
                → lưu { canvas, gl, program, texture } vào filterState[viewportId]

        [Mỗi lần render]
            → gl.useProgram(program)
            → gl.texImage2D(TEXTURE_2D, ..., sourceCanvas)
              ← upload toàn bộ pixel của canvas Cornerstone lên GPU
            → gl.uniform2f('u_textureSize', width, height)
            → gl.uniform1fv('u_kernel[0]', [0,-1,0,-1,5,-1,0,-1,0])
              ← kernel sharpen
            → gl.clear() + gl.drawArrays(TRIANGLE_STRIP, 0, 4)
              ← GPU thực hiện convolution, kết quả trên offscreen canvas

        → return offscreen canvas (đã có pixel filtered)

    → ctx = canvas.getContext('2d')
    → ctx.drawImage(filteredCanvas, 0, 0)
      ← GHI ĐÈ canvas gốc của Cornerstone với kết quả đã lọc
      ← Xảy ra trước browser paint → không bao giờ thấy frame chưa lọc
```

---

#### Bước 6 — Các frame tiếp theo (scroll, zoom, WL adjust...)

```
Mỗi khi Cornerstone re-render (vì bất kỳ lý do gì):
    → IMAGE_RENDERED fired lại
    → renderHandler chạy lại
    → WebGL context đã có sẵn (không cần init lại)
    → Chỉ thực hiện: texImage2D + drawArrays + drawImage
    → Filter liên tục được áp dụng sau mỗi frame Cornerstone render
```

---

#### Bước 7 — Bấm "None" để tắt filter

```
Người dùng bấm "None"
    → imageFilterService.setFilter(viewportId, 'none')
    → viewport.render()
    → IMAGE_RENDERED → renderHandler()
        → getFilter(viewportId) === 'none'
        → return (bỏ qua toàn bộ pipeline WebGL)
    → canvas gốc hiển thị nguyên bản từ Cornerstone (không bị ghi đè)
    → WebGL context vẫn còn trong filterState (sẽ tái sử dụng nếu bật filter lại)
```

---

#### Bước 8 — Viewport unmount: Dọn dẹp

```
OHIFCornerstoneViewport.tsx cleanup (useEffect return function)
    → cornerstoneViewportService.storePresentation(viewportId)
    → cleanUpServices(viewportInfo)
    → if (filterRenderer && enabledVPElement):
        → filterRenderer.disableFilterRendering(viewportId, enabledVPElement)
            → xóa listener IMAGE_RENDERED khỏi element
            → eventListeners.delete(viewportId)
            → imageFilterService.dispose(viewportId)
                → gl.deleteProgram(program)
                → gl.deleteTexture(texture)
                → delete filterState[viewportId]
```

---

**Tại sao không flash?** `IMAGE_RENDERED` được fired bởi Cornerstone trước khi trình duyệt thực hiện paint. Do đó, khi `ctx.drawImage()` ghi đè canvas gốc, trình duyệt chỉ paint một lần duy nhất — ảnh đã được lọc — không bao giờ hiển thị frame chưa lọc.

### 4. Quản lý WebGL context

Mỗi viewport có một entry riêng trong `filterState`:

```typescript
interface FilterState {
  [viewportId: string]: {
    filterType: FilterType;
    canvas?: HTMLCanvasElement;   // offscreen canvas
    gl?: WebGLRenderingContext;
    program?: WebGLProgram;
    texture?: WebGLTexture;
  };
}
```

- WebGL được khởi tạo lazy (lần đầu tiên `applyFilter` được gọi với viewport đó).
- Nếu kích thước canvas thay đổi (resize viewport), `canvas.width/height` được cập nhật tự động và gọi lại `gl.viewport()`.
- Khi viewport bị unmount, `dispose(viewportId)` giải phóng program và texture.

---

## UI Component — ImageFilter.tsx

**Props:**

| Prop | Kiểu | Mô tả |
|------|------|-------|
| `viewportId` | `string` | ID của viewport đang active |

**Hành vi:**

1. Khi mount: đọc filter hiện tại từ `imageFilterService.getFilter(viewportId)` để đồng bộ state.
2. Khi người dùng bấm một nút:
   - Gọi `imageFilterService.setFilter(viewportId, filterType)` để lưu trạng thái.
   - Gọi `viewport.render()` để trigger Cornerstone render → kích hoạt `IMAGE_RENDERED` → filter được áp dụng.
3. Nút đang chọn hiển thị màu primary và icon checkmark.

---

## Tích hợp Service

`ImageFilterService` được đăng ký vào OHIF service registry thông qua:

```typescript
static REGISTRATION = {
  name: 'imageFilterService',
  altName: 'ImageFilterService',
  create: ({ servicesManager }) => new ImageFilterService(servicesManager),
};
```

Sau đó có thể truy cập từ bất kỳ đâu qua:

```typescript
const { imageFilterService } = servicesManager.services;
```

---

## Lưu ý và hạn chế

- **WebGL bắt buộc:** Nếu trình duyệt không hỗ trợ WebGL, filter sẽ không hoạt động (hàm `applyFilter` trả về `null`, không crash).
- **Chỉ áp dụng cho canvas 2D:** Filter ghi lên canvas của Cornerstone stack viewport (2D). Volume viewport (MPR) dùng WebGL renderer riêng và không được hỗ trợ.
- **Không lưu giữa phiên:** Trạng thái filter được lưu trong memory, không persist khi reload trang.
- **Filter `none` tối ưu:** Khi filter là `none`, `ViewportFilterRenderer` return sớm, không tạo WebGL context, không tốn GPU.
