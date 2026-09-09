// Markdown -> Word (.docx), using the `docx` package.
//
// Loaded lazily by render/index.js: a conversation that never asks for a Word
// document never loads this module or its dependency.

import { parseMarkdownBlocks, parseInlineRuns } from "./markdown-ast.js";

const HEADING_LEVELS = ["Heading1", "Heading2", "Heading3", "Heading4", "Heading5", "Heading6"];

export async function markdownToDocx(source, meta = {}) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, WidthType, AlignmentType } =
    await import("docx");

  const blocks = parseMarkdownBlocks(source);
  const children = [];

  // The document opens with its own title, so the file is self-describing when
  // opened outside the panel — the card's title is otherwise nowhere in it.
  if (meta.title) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun({ text: String(meta.title), bold: true })]
      })
    );
  }

  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        children.push(
          new Paragraph({
            heading: HeadingLevel[HEADING_LEVELS[Math.min(block.level, 6) - 1].toUpperCase()] || HeadingLevel.HEADING_1,
            children: runsFor(block.text, TextRun)
          })
        );
        break;
      case "paragraph":
        children.push(new Paragraph({ children: runsFor(block.text, TextRun) }));
        break;
      case "list":
        for (const item of block.items) {
          children.push(
            new Paragraph({
              children: runsFor(item.text, TextRun),
              bullet: block.ordered ? undefined : { level: Math.min(item.depth, 4) },
              numbering: block.ordered ? { reference: "ordered-list", level: Math.min(item.depth, 4) } : undefined
            })
          );
        }
        break;
      case "table":
        children.push(buildTable(block, { Table, TableRow, TableCell, Paragraph, TextRun, WidthType, AlignmentType }));
        break;
      case "code":
        for (const line of block.text.split("\n")) {
          children.push(new Paragraph({ children: [new TextRun({ text: line, font: "Consolas", size: 20 })] }));
        }
        break;
      case "hr":
        children.push(new Paragraph({ text: "", border: { bottom: { style: "single", size: 6, space: 1 } } }));
        break;
      default:
        break;
    }
  }

  const doc = new Document({
    title: meta.title ? String(meta.title) : undefined,
    numbering: {
      config: [
        {
          reference: "ordered-list",
          levels: [0, 1, 2, 3, 4].map((level) => ({
            level,
            format: "decimal",
            text: `%${level + 1}.`,
            alignment: "start"
          }))
        }
      ]
    },
    sections: [{ properties: {}, children: children.length ? children : [new Paragraph({ text: "" })] }]
  });
  return Packer.toBuffer(doc);
}

function runsFor(text, TextRun) {
  return parseInlineRuns(text).map(
    (run) =>
      new TextRun({
        text: run.text,
        bold: !!run.bold,
        italics: !!run.italic,
        ...(run.code ? { font: "Consolas" } : {})
      })
  );
}

function buildTable(block, ctx) {
  const { Table, TableRow, TableCell, Paragraph, TextRun, WidthType } = ctx;
  const rows = [];
  const cell = (text, bold) =>
    new TableCell({
      children: [
        new Paragraph({
          children: parseInlineRuns(text).map(
            (run) => new TextRun({ text: run.text, bold: bold || !!run.bold, italics: !!run.italic })
          )
        })
      ]
    });

  rows.push(new TableRow({ children: block.header.map((h) => cell(h, true)), tableHeader: true }));
  const width = block.header.length;
  for (const row of block.rows) {
    // Ragged rows are padded rather than dropped: a table cell the model
    // omitted should show as empty, not silently shorten the row.
    const cells = [];
    for (let i = 0; i < width; i += 1) cells.push(cell(row[i] ?? "", false));
    rows.push(new TableRow({ children: cells }));
  }
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}
