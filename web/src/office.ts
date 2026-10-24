// Office formats (.docx, .pptx, .xlsx) generation, import, and export utilities.
import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  Packer,
} from 'docx';
import pptxgen from 'pptxgenjs';
import * as XLSX from 'xlsx';
import { renderAsync } from 'docx-preview';
import { splitSlides } from './components/Artifacts';

export interface SheetData {
  name: string;
  rows: string[][];
}

export interface SheetWorkbook {
  sheets: SheetData[];
}

/** Triggers a browser download of a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// ==================== WORD (.docx) ====================

interface TextSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/** Parses inline markdown (*italic*, **bold**, `code`, etc.) into spans. */
function parseInlineMarkdown(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let remaining = text;

  // Regex matching **bold**, *italic*, and `code`
  const regex = /(\*\*|__)(.*?)\1|(\*|_)(.*?)\3|(`)(.*?)\5/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      spans.push({ text: text.slice(lastIndex, match.index) });
    }
    if (match[1]) {
      // Bold
      spans.push({ text: match[2], bold: true });
    } else if (match[3]) {
      // Italic
      spans.push({ text: match[4], italic: true });
    } else if (match[5]) {
      // Inline code
      spans.push({ text: match[6], code: true });
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    spans.push({ text: text.slice(lastIndex) });
  }

  return spans.length ? spans : [{ text }];
}

function spansToRuns(spans: TextSpan[]): TextRun[] {
  return spans.map(
    (s) =>
      new TextRun({
        text: s.text,
        bold: s.bold,
        italics: s.italic,
        font: s.code ? 'Consolas' : undefined,
        size: s.code ? 20 : 24, // half-points (24 = 12pt)
      }),
  );
}

/** Converts Markdown text to a native Word document (.docx). */
export async function markdownToDocx(markdown: string, title?: string): Promise<Blob> {
  const lines = markdown.split(/\r?\n/);
  const children: (Paragraph | Table)[] = [];

  let inTable = false;
  let tableRows: string[][] = [];

  const flushTable = () => {
    if (!inTable || tableRows.length === 0) return;
    const maxCols = Math.max(...tableRows.map((r) => r.length));
    const rows = tableRows.map((r, rowIndex) => {
      const isHeader = rowIndex === 0;
      const cells = Array.from({ length: maxCols }, (_, cIdx) => {
        const cellText = r[cIdx] ?? '';
        return new TableCell({
          width: { size: Math.floor(100 / maxCols), type: WidthType.PERCENTAGE },
          shading: isHeader ? { fill: 'F3F4F6' } : undefined,
          children: [
            new Paragraph({
              children: spansToRuns(parseInlineMarkdown(cellText)),
            }),
          ],
        });
      });
      return new TableRow({
        tableHeader: isHeader,
        children: cells,
      });
    });

    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows,
      }),
    );

    // Empty space after table
    children.push(new Paragraph({ text: '' }));
    tableRows = [];
    inTable = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Markdown Table row
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      // Skip separator row like |---|---|
      if (cells.every((c) => /^:?-+:?$/.test(c))) {
        continue;
      }
      inTable = true;
      tableRows.push(cells);
      continue;
    } else if (inTable) {
      flushTable();
    }

    if (!trimmed) {
      continue;
    }

    // Headings
    if (trimmed.startsWith('# ')) {
      children.push(
        new Paragraph({
          text: trimmed.slice(2),
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 120 },
        }),
      );
    } else if (trimmed.startsWith('## ')) {
      children.push(
        new Paragraph({
          text: trimmed.slice(3),
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 100 },
        }),
      );
    } else if (trimmed.startsWith('### ')) {
      children.push(
        new Paragraph({
          text: trimmed.slice(4),
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 160, after: 80 },
        }),
      );
    } else if (/^[-*+]\s+/.test(trimmed)) {
      // Bullet list item
      const itemText = trimmed.replace(/^[-*+]\s+/, '');
      children.push(
        new Paragraph({
          children: spansToRuns(parseInlineMarkdown(itemText)),
          bullet: { level: 0 },
          spacing: { after: 80 },
        }),
      );
    } else if (/^\d+\.\s+/.test(trimmed)) {
      // Numbered list item
      const itemText = trimmed.replace(/^\d+\.\s+/, '');
      children.push(
        new Paragraph({
          children: spansToRuns(parseInlineMarkdown(itemText)),
          spacing: { after: 80 },
        }),
      );
    } else if (trimmed.startsWith('>')) {
      // Blockquote
      const quoteText = trimmed.replace(/^>\s*/, '');
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: quoteText,
              italics: true,
              color: '4B5563',
            }),
          ],
          border: {
            left: {
              color: '9CA3AF',
              space: 10,
              style: BorderStyle.SINGLE,
              size: 16,
            },
          },
          spacing: { before: 100, after: 100 },
        }),
      );
    } else {
      // Regular paragraph
      children.push(
        new Paragraph({
          children: spansToRuns(parseInlineMarkdown(line)),
          spacing: { after: 120, line: 280 },
        }),
      );
    }
  }

  if (inTable) flushTable();

  const doc = new Document({
    title: title || 'Document',
    sections: [
      {
        properties: {},
        children: children.length > 0 ? children : [new Paragraph({ text: '' })],
      },
    ],
  });

  return await Packer.toBlob(doc);
}

/** Renders a Word (.docx) document inside a container DOM element using docx-preview. */
export async function renderDocx(bufferOrBlob: ArrayBuffer | Blob, container: HTMLElement): Promise<void> {
  container.innerHTML = '';
  await renderAsync(bufferOrBlob, container, undefined, {
    className: 'docx-preview-root',
    inWrapper: true,
    ignoreWidth: false,
    ignoreHeight: false,
  });
}

// ==================== POWERPOINT (.pptx) ====================

/** Converts a Markdown slide deck to a native PowerPoint (.pptx) presentation. */
export async function markdownToPptx(markdown: string, presentationTitle?: string): Promise<Blob> {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_16x9';

  const slides = splitSlides(markdown);

  slides.forEach((slideText, index) => {
    const slide = pptx.addSlide();
    const lines = slideText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    if (lines.length === 0) return;

    if (index === 0) {
      // Title slide design
      const titleLine = lines.find((l) => l.startsWith('# '))?.replace(/^#\s+/, '') || presentationTitle || lines[0].replace(/^#+\s*/, '');
      const otherLines = lines.filter((l) => !l.startsWith('# ') && l !== titleLine);
      const subtitle = otherLines.join('\n');

      slide.background = { color: '1E293B' }; // Slate 800 dark theme for title slide
      slide.addText(titleLine, {
        x: 1.0,
        y: 2.2,
        w: 11.3,
        h: 1.6,
        fontSize: 38,
        bold: true,
        color: 'FFFFFF',
        align: 'center',
        fontFace: 'Arial',
      });

      if (subtitle) {
        slide.addText(subtitle, {
          x: 1.5,
          y: 4.0,
          w: 10.3,
          h: 1.5,
          fontSize: 20,
          color: '94A3B8',
          align: 'center',
          fontFace: 'Arial',
        });
      }
    } else {
      // Content slide
      slide.background = { color: 'FFFFFF' };

      const heading = lines.find((l) => l.startsWith('## ') || l.startsWith('# '))?.replace(/^#+\s*/, '') || `Slide ${index + 1}`;
      const contentLines = lines.filter((l) => !l.startsWith('# ') && !l.startsWith('## '));

      // Slide Title
      slide.addText(heading, {
        x: 0.8,
        y: 0.6,
        w: 11.7,
        h: 0.9,
        fontSize: 28,
        bold: true,
        color: '0F172A',
        fontFace: 'Arial',
      });

      // Accent underline
      slide.addShape(pptx.ShapeType.rect, {
        x: 0.8,
        y: 1.5,
        w: 1.8,
        h: 0.05,
        fill: { color: '2563EB' },
        line: { color: '2563EB' },
      });

      // Check for table
      const tableRows = contentLines.filter((l) => l.startsWith('|') && l.endsWith('|'));
      if (tableRows.length >= 2) {
        const rowsData: pptxgen.TableRow[] = [];
        tableRows.forEach((r, rIdx) => {
          const cells = r.slice(1, -1).split('|').map((c) => c.trim());
          if (cells.every((c) => /^:?-+:?$/.test(c))) return;
          const isHdr = rowsData.length === 0;
          rowsData.push(
            cells.map((c) => ({
              text: c,
              options: {
                fill: { color: isHdr ? 'F1F5F9' : 'FFFFFF' },
                bold: isHdr,
                fontSize: 14,
                color: isHdr ? '0F172A' : '334155',
                border: { pt: 1, color: 'E2E8F0' },
              },
            })),
          );
        });

        if (rowsData.length > 0) {
          slide.addTable(rowsData, {
            x: 0.8,
            y: 1.9,
            w: 11.7,
            fontSize: 14,
          });
          return;
        }
      }

      // Bullets and content text
      const bulletItems: { text: string; options: pptxgen.TextPropsOptions }[] = [];
      contentLines.forEach((line) => {
        const clean = line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '');
        bulletItems.push({
          text: clean,
          options: {
            bullet: /^[-*+]\s+/.test(line),
            fontSize: 18,
            color: '334155',
            breakLine: true,
            paraSpaceAfter: 12,
            fontFace: 'Arial',
          },
        });
      });

      if (bulletItems.length > 0) {
        slide.addText(bulletItems, {
          x: 0.8,
          y: 1.9,
          w: 11.7,
          h: 4.8,
          valign: 'top',
        });
      }
    }
  });

  return (await pptx.write({ outputType: 'blob' })) as Blob;
}

// ==================== EXCEL (.xlsx) & SPREADSHEETS ====================

/** Parses workbook content from CSV, multi-sheet text, or JSON. */
export function parseSheetWorkbook(content: string): SheetWorkbook {
  if (!content.trim()) {
    return {
      sheets: [{ name: 'Sheet1', rows: [['', '', ''], ['', '', ''], ['', '', '']] }],
    };
  }

  // 1. Try JSON representation
  try {
    const parsed = JSON.parse(content);
    if (parsed && Array.isArray(parsed.sheets) && parsed.sheets.length > 0) {
      return {
        sheets: parsed.sheets.map((s: any, idx: number) => ({
          name: s.name || `Sheet${idx + 1}`,
          rows: Array.isArray(s.rows)
            ? s.rows.map((r: any) => (Array.isArray(r) ? r.map(String) : [String(r)]))
            : Array.isArray(s.data)
              ? s.data.map((r: any) => (Array.isArray(r) ? r.map(String) : [String(r)]))
              : [['']],
        })),
      };
    }
  } catch {
    // Not JSON
  }

  // 2. Check for multi-sheet text format: "## Sheet: Name"
  if (/^##\s+Sheet:\s+/m.test(content)) {
    const parts = content.split(/^##\s+Sheet:\s+/m).filter(Boolean);
    const sheets: SheetData[] = [];
    for (const part of parts) {
      const firstLineEnd = part.indexOf('\n');
      const sheetName = (firstLineEnd > 0 ? part.slice(0, firstLineEnd) : part).replace(/\s*\(.*?\)/, '').trim();
      const body = firstLineEnd > 0 ? part.slice(firstLineEnd) : '';
      const csvClean = body.replace(/```(?:csv)?/g, '').trim();
      sheets.push({
        name: sheetName || `Sheet${sheets.length + 1}`,
        rows: parseCsv(csvClean),
      });
    }
    if (sheets.length > 0) return { sheets };
  }

  // 3. Fallback: single sheet CSV
  return {
    sheets: [{ name: 'Sheet1', rows: parseCsv(content) }],
  };
}

/** Parses CSV text into rows of string cells, preserving quotes and commas. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '').trim();
  if (!clean) return [['']];
  try {
    const wb = XLSX.read(clean, { type: 'string' });
    const firstSheetName = wb.SheetNames[0];
    if (firstSheetName) {
      const sheet = wb.Sheets[firstSheetName];
      const data = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '' });
      if (data.length > 0) {
        return data.map((row) => (Array.isArray(row) ? row.map((c) => String(c ?? '')) : [String(row ?? '')]));
      }
    }
  } catch {
    // Fallback simple line splitting
  }

  const lines = clean.split(/\r?\n/);
  return lines.map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '').trim()));
}

/** Serializes a SheetWorkbook to string for artifact storage. */
export function serializeSheetWorkbook(wb: SheetWorkbook): string {
  if (wb.sheets.length === 1) {
    const ws = XLSX.utils.aoa_to_sheet(wb.sheets[0].rows);
    return XLSX.utils.sheet_to_csv(ws);
  }

  return JSON.stringify(wb, null, 2);
}

/** Exports SheetWorkbook to an Excel (.xlsx) Blob. */
export function workbookToXlsx(wbData: SheetWorkbook): Blob {
  const wb = XLSX.utils.book_new();

  for (const sheet of wbData.sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31) || 'Sheet');
  }

  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** Reads a .xlsx, .xls, or .csv File or ArrayBuffer into a SheetWorkbook. */
export function readSpreadsheetFile(data: ArrayBuffer | Uint8Array): SheetWorkbook {
  const wb = XLSX.read(data, { type: 'array' });
  const sheets: SheetData[] = [];

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
    sheets.push({
      name,
      rows: rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [String(r ?? '')])),
    });
  }

  return { sheets: sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [['']] }] };
}
