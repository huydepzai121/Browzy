# Design — agent-created document artifacts

## 1. Why not the SDK's own artifact path

`sdk.d.ts` of the pinned `@anthropic-ai/claude-agent-sdk@0.3.263` exposes
`enableArtifact` / `disableArtifact` (lines 6268–6274). That tool publishes a
page to claude.ai and requires a Claude account. The extension's own manifest
description states the opposite property: "No Claude account needed. Any
Anthropic-compatible provider." The remaining file-shaped fields —
`SDKTaskNotificationMessage.output_file` (5216), staged-call
`input_files`/`output_files` (4127–4139), `file_attachments?: unknown[]` (5458)
— are subagent-task and tool-staging mechanics with no public user-facing
contract. Therefore the feature is built application-side, on the `ask_user`
pattern that already exists in this repo.

## 2. Decision: one tool, host-owned filesystem, no builtin widened

`Bash`/`Write`/`Edit`/`NotebookEdit` remain in `HIGH_RISK_BUILTINS`
(`host/agent/tools/query-options.js`). The model never names a path. It calls:

```
create_document({ title, format?, content })
```

- `title` — human title shown on the card. The **filename** is derived by the
  host: slugified title + extension. The model cannot influence the path.
- `format` — `md` (default) | `txt` | `csv` | `html` | `json` | `docx` | `xlsx`
  | `pptx` | `pdf`.
- `content` — markdown for the document formats; for `csv`/`xlsx` the model may
  pass a markdown table and the host converts it.

The host writes to `<conversation workspace>/documents/<docId>.<ext>` plus a
sibling `<docId>.json` metadata record. `docId` is host-minted
(`crypto.randomUUID()`), never model-supplied — a model-supplied id could
address another conversation's record.

**Guards** (all host-side, all rejecting rather than truncating silently):
filename slug limited to `[a-z0-9-]{1,80}`; content limited to 2 MB of source;
generated file limited to 10 MB (matches the existing attachment ceiling); at
most 50 documents per conversation.

## 3. Decision: metadata on the event, bytes on demand

`run.emit({ type: "document_created", documentId, title, fileName, format,
mimeType, byteLength })`. The bytes never ride the stream event — a 10 MB
document would blow the native-messaging message ceiling and would be paid for
on every reconnect snapshot replay, for a document the operator may never open.

The panel fetches bytes only when the operator opens or downloads a card:
`document_fetch { conversationId, documentId }` → host reads the file →
`chunkBuffer()` (`host/agent/broker/chunked-transport.js`, `kind:
"document_bytes"`) → background reassembles → `Blob`.

`chunked-transport.js` already implements both halves symmetrically, but the
extension side only has the **sender** (`chunkBytesForWire` in
`extension/background.js:1903`). A `Reassembler` counterpart is added in the
extension, mirroring the host module's envelope validation (id match, index
order, total bytes, expiry) so a stale or truncated sequence is rejected rather
than yielding a corrupt blob.

## 4. Decision: Preview and Markdown exist for every format

| format | Preview tab | Markdown tab |
|---|---|---|
| md | `markdown-lite` → panel DOM (already XSS-safe) | source text |
| txt / json / csv | `<pre>` (csv also as a table) | fenced source |
| html | sandboxed iframe `srcdoc` | `turndown` of the HTML |
| docx | `docx-preview` HTML in a sandboxed iframe | `mammoth` → HTML → `turndown` |
| xlsx | sheet tables in a sandboxed iframe | GFM pipe tables per sheet |
| pptx | per-slide title + bullets, extracted with `fflate` + XML parse | same, as a markdown outline |
| pdf | `pdfjs-dist` canvas pages | `pdfjs-dist` text layer joined per page |

PPTX has no faithful in-browser renderer. Its Preview is an extraction, and the
UI says so — an honest limitation beats a silently lossy render.

**Untrusted-HTML rule.** Everything a converter emits is untrusted: it derives
from model output and, transitively, from page content the model quoted. Only
`markdown-lite` output — which escapes every character before formatting — goes
into the panel DOM. Every converter's HTML goes into
`<iframe sandbox srcdoc="...">` with no `allow-scripts` and no `allow-same-origin`,
so an injected `<script>` cannot run and cannot reach the panel's DOM,
`chrome.*`, or storage.

## 5. Decision: lifetime is the conversation

Documents live in the conversation workspace and their card metadata is
persisted in `history-store.js`, so a panel reload rebuilds a live card whose
Download and Preview still work. Deleting the conversation deletes the
`documents/` directory. This rules out the "temp file" alternative, where a
reload leaves dead cards in the transcript.

## 6. Bundle-size handling

`pdfjs-dist` (with its worker) is the single largest addition. All viewer
libraries are loaded by dynamic `import()` at the moment a document of that
format is first opened, so a session that never opens a PDF never pays for
pdf.js. The card, the modal shell, and the md/txt/csv/json/html paths carry no
vendored dependency at all.

## 7. Risks

- A vendored build that uses `eval`/`new Function` violates the MV3 CSP. Each
  vendored file is verified after copying (grep for `eval(`/`new Function`),
  never trusted from its documentation.
- npm's `xlsx` package (0.18.5) is stale and carries an unpatched
  prototype-pollution advisory; `exceljs` (MIT, 4.4.0) is used instead on both
  the host and the panel side.
- `pptxgenjs` pulls in `image-size`, which carries a denial-of-service
  advisory in its ICNS/JXL/HEIF parsers. That parser only runs when an image is
  added to a slide, and the deck generator here is built from the run's text
  alone, so the vulnerable path is not reachable through this code. Recorded
  rather than dismissed: adding an image to a generated deck later would make
  it reachable.
- The PDF path embeds DejaVu Sans (~1.4 MB of TTF in the host package). Not
  optional: pdf-lib's standard fonts are WinAnsi and throw on the first
  Vietnamese character. Licensing is recorded in NOTICE.
- The change spans host, background, and panel. It ships in three commits
  (core path → viewers → binary generators) rather than one diff.
