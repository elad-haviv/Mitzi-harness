// Turns documents into text the model can read, in the browser: PDF (pdf.js), Word, Excel and
// PowerPoint (zips of XML), and plain-text formats. Nothing is uploaded until the text is extracted.
import { readZipTexts } from './unzip';

export const MAX_DOCUMENT = 30 * 1024 * 1024;
/** Extracted text beyond this is cut, so one document can't swamp the context. */
const MAX_CHARS = 400_000;

const OFFICE = /\.(docx|xlsx|pptx)$/i;
const PDF = /\.pdf$/i;
const TEXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|ya?ml|toml|ini|log|rtf|tex|srt|vtt|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sql|sh|ps1|css|scss|vue|svelte)$/i;

export function isDocument(name: string): boolean {
  return PDF.test(name) || OFFICE.test(name);
}

export interface Extracted {
  text: string;
  /** What was read, for the user: "12 pages", "3 sheets"… */
  summary: string;
  truncated: boolean;
}

const xml = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
const byLocal = (root: Document | Element, name: string) => Array.from(root.getElementsByTagNameNS('*', name));
const num = (path: string) => Number(/(\d+)\.xml$/.exec(path)?.[1] ?? 0);

function finish(text: string, summary: string): Extracted {
  const clean = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return clean.length > MAX_CHARS ? { text: `${clean.slice(0, MAX_CHARS)}\n\n[… the rest of the document was cut]`, summary, truncated: true } : { text: clean, summary, truncated: false };
}

async function pdf(file: File): Promise<Extracted> {
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: string[] = [];
  let total = 0;
  for (let i = 1; i <= doc.numPages && total < MAX_CHARS; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Rebuild lines from the positioned text runs.
    let line = '';
    let lastY: number | undefined;
    const lines: string[] = [];
    for (const item of content.items as { str: string; transform: number[]; hasEOL?: boolean }[]) {
      const y = item.transform?.[5];
      if (lastY !== undefined && y !== undefined && Math.abs(y - lastY) > 2 && line) {
        lines.push(line);
        line = '';
      }
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = '';
      }
      lastY = y;
    }
    if (line) lines.push(line);
    const text = lines.join('\n').trim();
    total += text.length;
    pages.push(`--- Page ${i} ---\n${text}`);
  }
  const empty = pages.every((p) => !p.replace(/--- Page \d+ ---/, '').trim());
  if (empty) throw new Error(`${file.name} has no text layer (it's probably scanned). Attach the pages as images instead, so a vision model can read them.`);
  return finish(pages.join('\n\n'), `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`);
}

/** Word: paragraphs (with headings and list items) and tables, in order. */
async function docx(file: File): Promise<Extracted> {
  const parts = await readZipTexts(file, (n) => n === 'word/document.xml');
  const body = parts.get('word/document.xml');
  if (!body) throw new Error(`${file.name} doesn't look like a Word document`);
  const doc = xml(body);
  const out: string[] = [];
  const paragraphText = (p: Element) => byLocal(p, 't').map((t) => t.textContent ?? '').join('');
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (child.localName === 'p') {
        const text = paragraphText(child).trim();
        if (!text) continue;
        const style = byLocal(child, 'pStyle')[0]?.getAttribute('w:val') ?? '';
        const heading = /^Heading(\d)$/i.exec(style) ?? (/^Title$/i.test(style) ? [, '1'] : null);
        const list = byLocal(child, 'numPr').length > 0 || /List/i.test(style);
        out.push(heading ? `${'#'.repeat(Number(heading[1]))} ${text}` : list ? `- ${text}` : text);
      } else if (child.localName === 'tbl') {
        const rows = byLocal(child, 'tr').map((tr) => byLocal(tr, 'tc').map((tc) => byLocal(tc, 'p').map(paragraphText).join(' ').replace(/\|/g, '\\|').trim()));
        if (rows.length) {
          const width = Math.max(...rows.map((r) => r.length));
          const line = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
          out.push([line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n'));
        }
      } else if (child.children.length) walk(child);
    }
  };
  walk(byLocal(doc, 'body')[0] ?? doc.documentElement);
  return finish(out.join('\n\n'), `${out.length} paragraphs`);
}

/** Excel: each sheet as a CSV block (first 2,000 rows), with the values cells display. */
async function xlsx(file: File): Promise<Extracted> {
  const parts = await readZipTexts(file, (n) => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = parts.has('xl/sharedStrings.xml') ? byLocal(xml(parts.get('xl/sharedStrings.xml')!), 'si').map((si) => byLocal(si, 't').map((t) => t.textContent ?? '').join('')) : [];
  // Sheet names, in workbook order, mapped to their files.
  const rels = new Map(
    parts.has('xl/_rels/workbook.xml.rels') ? byLocal(xml(parts.get('xl/_rels/workbook.xml.rels')!), 'Relationship').map((r) => [r.getAttribute('Id'), `xl/${(r.getAttribute('Target') ?? '').replace(/^\/?xl\//, '')}`]) : [],
  );
  const sheets = parts.has('xl/workbook.xml')
    ? byLocal(xml(parts.get('xl/workbook.xml')!), 'sheet').map((s) => ({ name: s.getAttribute('name') ?? 'Sheet', path: rels.get(s.getAttribute('r:id') ?? s.getAttributeNS('*', 'id')) ?? '' }))
    : [...parts.keys()].filter((k) => k.startsWith('xl/worksheets/')).sort((a, b) => num(a) - num(b)).map((path, i) => ({ name: `Sheet${i + 1}`, path }));
  const col = (ref: string) => {
    const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
    return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  };
  const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const blocks: string[] = [];
  for (const sheet of sheets) {
    const data = parts.get(sheet.path);
    if (!data) continue;
    const rows = byLocal(xml(data), 'row');
    const lines: string[] = [];
    for (const row of rows.slice(0, 2000)) {
      const cells: string[] = [];
      for (const c of byLocal(row, 'c')) {
        const t = c.getAttribute('t');
        const v = byLocal(c, 'v')[0]?.textContent ?? byLocal(c, 't').map((x) => x.textContent ?? '').join('');
        cells[col(c.getAttribute('r') ?? 'A1')] = t === 's' ? (shared[Number(v)] ?? '') : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : v;
      }
      if (cells.some((x) => x)) lines.push(Array.from(cells, (x) => csvCell(x ?? '')).join(','));
    }
    blocks.push(`## Sheet: ${sheet.name}${rows.length > 2000 ? ` (first 2000 of ${rows.length} rows)` : ''}\n\`\`\`csv\n${lines.join('\n')}\n\`\`\``);
  }
  if (!blocks.length) throw new Error(`${file.name} doesn't look like an Excel workbook`);
  return finish(blocks.join('\n\n'), `${blocks.length} sheet${blocks.length === 1 ? '' : 's'}`);
}

/** PowerPoint: each slide's text, with its speaker notes. */
async function pptx(file: File): Promise<Extracted> {
  const parts = await readZipTexts(file, (n) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(n));
  const slides = [...parts.keys()].filter((k) => k.startsWith('ppt/slides/')).sort((a, b) => num(a) - num(b));
  if (!slides.length) throw new Error(`${file.name} doesn't look like a PowerPoint presentation`);
  const text = (s: string) =>
    byLocal(xml(s), 'p')
      .map((p) => byLocal(p, 't').map((t) => t.textContent ?? '').join(''))
      .filter((l) => l.trim())
      .join('\n');
  const out = slides.map((path) => {
    const n = num(path);
    const notes = parts.get(`ppt/notesSlides/notesSlide${n}.xml`);
    const noteText = notes ? text(notes).replace(/^\d+$/m, '').trim() : '';
    return `--- Slide ${n} ---\n${text(parts.get(path)!)}${noteText ? `\n\nSpeaker notes: ${noteText}` : ''}`;
  });
  return finish(out.join('\n\n'), `${slides.length} slide${slides.length === 1 ? '' : 's'}`);
}

/** Text of any supported file; throws with a readable message otherwise. */
export async function extractText(file: File): Promise<Extracted> {
  if (file.size > MAX_DOCUMENT) throw new Error(`${file.name} is larger than 30 MB`);
  if (PDF.test(file.name) || file.type === 'application/pdf') return pdf(file);
  if (/\.docx$/i.test(file.name)) return docx(file);
  if (/\.xlsx$/i.test(file.name)) return xlsx(file);
  if (/\.pptx$/i.test(file.name)) return pptx(file);
  if (/\.(doc|xls|ppt)$/i.test(file.name)) throw new Error(`${file.name} is in an old Office format. Save it as .docx, .xlsx or .pptx and attach that.`);
  const text = await file.text();
  if (text.includes('\u0000') && !TEXT.test(file.name)) throw new Error(`${file.name} looks like a binary file. Mitzi reads text, PDF, Word, Excel and PowerPoint files, and images.`);
  return finish(text, `${text.split('\n').length} lines`);
}
