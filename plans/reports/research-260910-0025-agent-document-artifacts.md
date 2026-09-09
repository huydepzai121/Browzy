# Nghiên cứu: thẻ tài liệu do agent tạo ("Document · MD") + trình xem 2 chế độ

Ngày: 2026-09-10 · Repo: `open-claude-in-chrome` · Nhánh: `main`

Yêu cầu gốc: giống Claude in Chrome — agent tạo file tạm, panel hiện thẻ đính kèm,
bấm vào xem chi tiết với 2 định dạng **Preview** và **Markdown**, có nút **Download**,
**không dùng Google Drive**, hỗ trợ thêm **PDF / Word / Excel**. Kèm câu hỏi: "có SDK không".

---

## 1. Trả lời câu hỏi "có SDK không"

### 1.1 Claude Agent SDK (đã ghim `0.3.263`) — KHÔNG có primitive dùng được

Bằng chứng đọc trực tiếp `host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:

| Thứ tìm thấy | Dòng | Kết luận |
|---|---|---|
| `enableArtifact` / `disableArtifact` (Artifact tool) | 6268–6274 | Publish trang lên claude.ai, **cần tài khoản Claude**. Dự án tuyên bố "No Claude account needed. Any Anthropic-compatible provider" (`extension/manifest.json`) → không dùng được. |
| `SDKTaskNotificationMessage.output_file` | 5216 | File log kết quả của subagent Task, không phải artifact cho người dùng. |
| `input_files` / `output_files` (staged tool call) | 4127–4139 | Cơ chế staging lane của tool call, không phải kênh xuất file cho UI. |
| `file_attachments?: unknown[]` | 5458 | Kiểu `unknown`, không có hợp đồng công khai. |

→ **Không có** API "agent xuất một file cho người dùng" trung lập nhà cung cấp.
Phải tự làm bằng **MCP tool do ứng dụng sở hữu**, đúng khuôn mẫu `ask_user`
(`host/agent/tools/ask-the-user.js` → `extraTools` + `extraToolNames` trong
`buildIsolatedOptions`).

Ràng buộc phải giữ: `Bash` / `Write` / `Edit` / `NotebookEdit` nằm trong
`HIGH_RISK_BUILTINS` (`host/agent/tools/query-options.js:70`) — ghi file tuỳ ý bị
tắt có chủ đích. Tool mới **không nới lỏng** điều đó: nó chỉ ghi vào
`<conversation workspace>/artifacts/` với tên file đã được chuẩn hoá.

### 1.2 Thư viện đọc/hiển thị (chạy trong side panel, MV3)

| Nhu cầu | Thư viện | Bản mới nhất | Giấy phép | Ghi chú MV3 |
|---|---|---|---|---|
| PDF | `pdfjs-dist` | 6.3.289 | Apache-2.0 | Phải vendor cả worker; build `legacy` không dùng `eval`. Không CDN (CSP). |
| DOCX → HTML | `docx-preview` | 0.4.0 | Apache-2.0 | Giữ layout tốt hơn mammoth. |
| DOCX → HTML/Markdown | `mammoth` | 1.12.2 | BSD-2-Clause | HTML ngữ nghĩa, hợp cho tab Markdown. |
| XLSX đọc/ghi | `exceljs` | 4.4.0 | MIT | **Khuyến nghị.** |
| XLSX đọc/ghi | `xlsx` (SheetJS) | 0.18.5 trên npm | Apache-2.0 | ⚠️ Bản npm đã ngưng cập nhật; lỗ hổng prototype-pollution chỉ được vá từ 0.19.3 trên CDN riêng của SheetJS. **Tránh dùng bản npm.** |
| HTML → Markdown | `turndown` | 7.2.4 | MIT | Dùng cho tab Markdown của docx/xlsx/pdf. |

Tiền lệ vendor đã có: `extension/vendor/rrweb.umd.min.js`, `rrweb-player.umd.min.js`.

### 1.3 Thư viện sinh file (chạy ở host, Node)

| Định dạng | Thư viện | Bản | Giấy phép |
|---|---|---|---|
| DOCX | `docx` | 9.7.1 | MIT |
| XLSX | `exceljs` | 4.4.0 | MIT |
| PDF | `pdf-lib` | 1.17.1 | MIT |

`md` / `txt` / `csv` / `html` / `json`: ghi thẳng, **không cần dependency**.

---

## 2. Kiến trúc đề xuất

```
model → mcp tool  create_document(fileName, format, content)
          ↓ (host/agent/tools/create-document.js)
       ghi <workspace>/artifacts/<runId>/<id>-<fileName>
          ↓ run.emit({type:"document_created", id, fileName, mimeType, byteLength, ...})
       companion → native messaging → background.js → side panel
          ↓ conversation-model: item kiểu "document"
       sidepanel.js: thẻ "Tên tài liệu · Document · MD" + nút Download
          ↓ bấm thẻ
       modal 2 tab: [Preview] [Markdown]   ← tái dùng khung attachment-picker-overlay
          ↓ cần bytes
       panel → background → host: document_fetch(id)
          ↓ host chunkBuffer() (host/agent/broker/chunked-transport.js)
       background reassemble → Blob → objectURL → render / <a download>
```

### Các điểm đã kiểm chứng trong repo

- **Khuôn mẫu tool ứng dụng sở hữu**: `host/agent/tools/ask-the-user.js` (219 dòng)
  — `tool()` + emit stream event + tracker request id. Bắt buộc khai tên tool ở
  **cả hai** nơi (`extraTools` khi tạo server và `extraToolNames` trong
  `buildIsolatedOptions`), nếu lệch thì tool đăng ký được nhưng model không gọi được.
- **Chunk transport đã có ở host**: `host/agent/broker/chunked-transport.js`
  (`chunkBuffer` + `Reassembler`, đối xứng hai chiều).
- **Phía extension chỉ có chiều gửi đi**: `chunkBytesForWire()` trong
  `extension/background.js:1903`; **chưa có reassembler** → phải bổ sung
  (bản sao đối xứng của `Reassembler`, ~60 dòng).
- **Khung modal đã có**: `attachment-picker-overlay` trong `sidepanel.html` /
  `sidepanel.js:1475`.
- **Markdown an toàn đã có**: `extension/sidepanel/markdown-lite.js` — escape
  toàn bộ đầu vào trước khi format; CSS đã có ở `extension/ui/prose.css`.

### Ràng buộc bảo mật bắt buộc

1. HTML sinh ra từ `docx-preview` / `mammoth` / bảng xlsx là **nội dung không tin
   cậy** → render trong `<iframe sandbox srcdoc>`, **không** đưa vào DOM chính.
   Chỉ đầu ra của `markdown-lite` mới được vào DOM chính (đúng quan điểm sẵn có:
   "content is DATA, never innerHTML").
2. `fileName` phải chuẩn hoá: bỏ đường dẫn, chặn `..`, giới hạn ký tự và độ dài.
3. Giới hạn kích thước mỗi tài liệu (đề xuất 10 MB, khớp giới hạn attachment hiện tại).
4. Không cần quyền `downloads`: tải về bằng `<a download>` trên blob URL.

---

## 3. Phân đoạn triển khai (giao đủ cả 3, theo thứ tự giảm rủi ro)

| Giai đoạn | Nội dung | Vì sao trước/sau |
|---|---|---|
| A | Tool `create_document` (md/txt/csv/html/json) + event + thẻ + Download + modal 2 tab + transport 2 chiều | Xuyên qua **mọi tầng**, gỡ rủi ro transport trước khi đụng thư viện nặng |
| B | Xem PDF/DOCX/XLSX: vendor `pdfjs-dist`, `docx-preview`, `exceljs`, `turndown`; tab Markdown = văn bản/bảng trích xuất | Chỉ là tầng render, không đổi giao thức |
| C | Sinh PDF/DOCX/XLSX ở host: thêm `docx`, `exceljs`, `pdf-lib` vào `host/package.json` | Tăng dependency của host — bước cuối |

Mỗi giai đoạn có test riêng: A → unit cho tool + reassembler + conversation-model;
B → unit cho bộ chuyển đổi sang markdown; C → unit cho sinh file (kiểm tra magic bytes).

---

## 4. Rủi ro đã biết

- `pdfjs-dist` bundle lớn (~1 MB+ kể cả worker) → tăng đáng kể kích thước
  `extension.zip`. Cân nhắc chỉ nạp lazy khi mở tài liệu PDF.
- Thư viện phải là bản UMD/ESM tự chứa; bất kỳ `eval`/`new Function` nào đều vi
  phạm CSP của MV3 → phải xác minh từng bản build sau khi vendor, không tin mô tả.
- Ba giai đoạn cộng lại là một thay đổi lớn chạm host + background + panel; nên
  commit theo từng giai đoạn thay vì một diff duy nhất.

## 4b. Quyết định đã chốt với người dùng (2026-09-10)

1. **Định dạng**: tài liệu agent tạo ra **không chỉ là markdown** — có thể là
   Word (`docx`), PowerPoint (`pptx`), Excel (`xlsx`), PDF, CSV, HTML.
   Vì vậy `create_document` nhận tham số `format`; markdown là mặc định.
2. **Vòng đời**: tài liệu **sống theo conversation** — lưu trong workspace của
   conversation, thẻ vẫn xem/tải được sau khi reload panel, dọn khi xoá conversation.

Bổ sung thư viện cho PowerPoint:

| Nhu cầu | Thư viện | Bản | Giấy phép |
|---|---|---|---|
| Sinh PPTX (host) | `pptxgenjs` | 4.0.1 | MIT |
| Đọc PPTX/DOCX/XLSX (giải nén OOXML trong panel) | `fflate` | 0.8.3 | MIT |

PPTX **không có** trình render trung thực chạy trong trình duyệt. Preview PPTX sẽ
là bản trích xuất có cấu trúc (tiêu đề + bullet từng slide) — nêu rõ giới hạn này
trong UI thay vì giả vờ render đầy đủ.
