// Markdown -> the text formats that are NOT just their own source.
//
// `md` and `txt` are stored verbatim — a markdown document is its source
// bytes. `csv` and `html` are not: the tool tells the model to write Markdown
// for every format, so a run asking for a spreadsheet-shaped file sends a pipe
// table and a run asking for a page sends markdown prose. Storing either
// verbatim would hand the operator a `.csv` full of `|` characters that no
// spreadsheet splits into columns, or an `.html` that renders as one flat
// paragraph of asterisks. These two converters are what make the stored file
// match the extension it was given.

import { parseMarkdownBlocks, parseInlineRuns, inlineToPlainText } from "./markdown-ast.js";

/**
 * Markdown -> RFC 4180 CSV.
 *
 * The first pipe table in the source becomes the sheet. With no table at all,
 * each block becomes a single-column row — still a valid CSV, so a run that
 * picked the wrong format never produces an unopenable file.
 */
export function markdownToCsv(source) {
  const blocks = parseMarkdownBlocks(source);
  const table = blocks.find((b) => b.type === "table");
  const rows = [];

  if (table) {
    rows.push(table.header.map(inlineToPlainText));
    const width = table.header.length;
    for (const row of table.rows) {
      const cells = [];
      for (let i = 0; i < width; i += 1) cells.push(inlineToPlainText(row[i] ?? ""));
      rows.push(cells);
    }
  } else {
    for (const block of blocks) {
      if (block.type === "list") for (const item of block.items) rows.push([inlineToPlainText(item.text)]);
      else if (block.type === "code") for (const line of block.text.split("\n")) rows.push([line]);
      else if (block.type === "heading" || block.type === "paragraph") rows.push([inlineToPlainText(block.text)]);
    }
  }

  // CRLF line endings: RFC 4180's own requirement, and what Excel expects.
  return `${rows.map((cells) => cells.map(csvField).join(",")).join("\r\n")}\r\n`;
}

/** Quote a field only when it needs it, doubling any embedded quote. */
function csvField(value) {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Markdown -> a complete, self-contained HTML document.
 *
 * Every piece of text is escaped on the way in, the same rule the panel's own
 * renderer follows: document content originates from model output and,
 * transitively, from page content the model may have quoted, so it is DATA and
 * never markup. A run that genuinely sends a full HTML document (it already
 * has an <html> element) is stored as written — that is a deliberate choice by
 * the run, and the panel still renders it inside a sandboxed frame.
 */
export function markdownToHtml(source, meta = {}) {
  if (/<html[\s>]/i.test(source)) return source.endsWith("\n") ? source : `${source}\n`;

  const body = [];
  for (const block of parseMarkdownBlocks(source)) {
    switch (block.type) {
      case "heading": {
        const level = Math.min(Math.max(block.level, 1), 6);
        body.push(`<h${level}>${inlineToHtml(block.text)}</h${level}>`);
        break;
      }
      case "paragraph":
        body.push(`<p>${inlineToHtml(block.text)}</p>`);
        break;
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        body.push(`<${tag}>`);
        for (const item of block.items) body.push(`<li>${inlineToHtml(item.text)}</li>`);
        body.push(`</${tag}>`);
        break;
      }
      case "table": {
        body.push("<table>");
        body.push(`<thead><tr>${block.header.map((h) => `<th>${inlineToHtml(h)}</th>`).join("")}</tr></thead>`);
        body.push("<tbody>");
        for (const row of block.rows) {
          const cells = [];
          for (let i = 0; i < block.header.length; i += 1) cells.push(`<td>${inlineToHtml(row[i] ?? "")}</td>`);
          body.push(`<tr>${cells.join("")}</tr>`);
        }
        body.push("</tbody></table>");
        break;
      }
      case "code":
        body.push(`<pre><code>${escapeHtml(block.text)}</code></pre>`);
        break;
      case "hr":
        body.push("<hr>");
        break;
      default:
        break;
    }
  }

  const title = escapeHtml(meta.title || "Document");
  return [
    "<!doctype html>",
    '<html lang="vi">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    "<style>",
    "body{font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:44rem;margin:2.5rem auto;padding:0 1.25rem;color:#1a1a1c}",
    "table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid #d5d5da;padding:.45rem .6rem;text-align:left}",
    "th{background:#f4f4f6}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em}",
    "pre{background:#f4f4f6;padding:.8rem;overflow:auto;border-radius:6px}hr{border:0;border-top:1px solid #d5d5da;margin:1.5rem 0}",
    "</style>",
    "</head>",
    "<body>",
    `<h1>${title}</h1>`,
    body.join("\n"),
    "</body>",
    "</html>",
    ""
  ].join("\n");
}

/** Inline markdown -> HTML, every run's text escaped before any tag is added. */
function inlineToHtml(text) {
  return parseInlineRuns(text)
    .map((run) => {
      const escaped = escapeHtml(run.text);
      if (run.code) return `<code>${escaped}</code>`;
      if (run.bold) return `<strong>${escaped}</strong>`;
      if (run.italic) return `<em>${escaped}</em>`;
      return escaped;
    })
    .join("");
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
