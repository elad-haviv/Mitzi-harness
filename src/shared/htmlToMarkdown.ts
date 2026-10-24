// Turns the HTML of the formatted document editor back into GitHub-flavored Markdown, so documents stay Markdown
// whichever way they're edited. Works on anything DOM-shaped (the browser's nodes, or plain objects in tests).

export interface MdNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<MdNode>;
  getAttribute?(name: string): string | null;
}

const TEXT = 3;
const ELEMENT = 1;
const BLOCKS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'HR', 'TABLE', 'LI', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER']);

const kids = (n: MdNode) => Array.from(n.childNodes);
const attr = (n: MdNode, name: string) => n.getAttribute?.(name) ?? '';

/** Inline content: text and emphasis, links, code, images and line breaks. */
function inline(n: MdNode): string {
  if (n.nodeType === TEXT) return (n.textContent ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ');
  if (n.nodeType !== ELEMENT) return '';
  const inner = () => kids(n).map(inline).join('');
  const wrap = (mark: string) => {
    const text = inner();
    // Emphasis can't start or end with a space in Markdown: move the spaces outside the marks.
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
    return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : text;
  };
  switch (n.nodeName) {
    case 'STRONG':
    case 'B':
      return wrap('**');
    case 'EM':
    case 'I':
      return wrap('*');
    case 'S':
    case 'DEL':
    case 'STRIKE':
      return wrap('~~');
    case 'CODE': {
      const code = n.textContent ?? '';
      return code.includes('`') ? `\`\` ${code} \`\`` : `\`${code}\``;
    }
    case 'A': {
      const href = attr(n, 'href');
      const text = inner();
      return href ? `[${text || href}](${href})` : text;
    }
    case 'IMG':
      return `![${attr(n, 'alt')}](${attr(n, 'src')})`;
    case 'BR':
      return '  \n';
    case 'INPUT':
      return attr(n, 'type') === 'checkbox' ? (n.getAttribute?.('checked') != null ? '[x] ' : '[ ] ') : '';
    default:
      return BLOCKS.has(n.nodeName) ? blocks(n).join('\n\n') : inner();
  }
}

function list(n: MdNode, depth: number): string {
  const ordered = n.nodeName === 'OL';
  let i = Number(attr(n, 'start')) || 1;
  return kids(n)
    .filter((c) => c.nodeName === 'LI')
    .map((li) => {
      const marker = ordered ? `${i++}. ` : '- ';
      const pad = ' '.repeat(marker.length);
      const own: string[] = [];
      const nested: string[] = [];
      let line = '';
      for (const c of kids(li)) {
        if (c.nodeName === 'UL' || c.nodeName === 'OL') nested.push(list(c, depth + 1));
        else if (c.nodeType === ELEMENT && BLOCKS.has(c.nodeName)) {
          if (line.trim()) own.push(line.trim());
          line = '';
          own.push(...blocks(c));
        } else line += inline(c);
      }
      if (line.trim()) own.push(line.trim());
      const body = own.join('\n\n').split('\n').map((l, j) => (j === 0 ? l : l ? pad + l : l)).join('\n');
      return `${marker}${body}${nested.length ? `\n${nested.map((x) => x.split('\n').map((l) => pad + l).join('\n')).join('\n')}` : ''}`;
    })
    .join('\n');
}

function table(n: MdNode): string {
  const rows: string[][] = [];
  const walk = (x: MdNode) => {
    for (const c of kids(x)) {
      if (c.nodeName === 'TR') rows.push(kids(c).filter((d) => d.nodeName === 'TD' || d.nodeName === 'TH').map((d) => kids(d).map(inline).join('').trim().replace(/\|/g, '\\|').replace(/\n/g, ' ')));
      else if (c.nodeType === ELEMENT) walk(c);
    }
  };
  walk(n);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const row = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  return [row(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(row)].join('\n');
}

/** The Markdown blocks of an element's children. */
function blocks(n: MdNode): string[] {
  const out: string[] = [];
  let line = '';
  const flush = () => {
    if (line.trim()) out.push(line.trim().replace(/ {2}\n$/, ''));
    line = '';
  };
  const one = (c: MdNode) => {
    switch (c.nodeName) {
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6': {
        const text = kids(c).map(inline).join('').trim();
        return text ? `${'#'.repeat(Number(c.nodeName[1]))} ${text}` : '';
      }
      case 'P':
        return kids(c).map(inline).join('').trim();
      case 'UL':
      case 'OL':
        return list(c, 0);
      case 'BLOCKQUOTE':
        return blocks(c)
          .join('\n\n')
          .split('\n')
          .map((l) => (l ? `> ${l}` : '>'))
          .join('\n');
      case 'PRE': {
        const code = kids(c).find((k) => k.nodeName === 'CODE');
        const lang = /language-(\S+)/.exec(code ? attr(code, 'class') : '')?.[1] ?? '';
        return `\`\`\`${lang}\n${(c.textContent ?? '').replace(/\n$/, '')}\n\`\`\``;
      }
      case 'HR':
        return '---';
      case 'TABLE':
        return table(c);
      default:
        return blocks(c).join('\n\n');
    }
  };
  for (const c of kids(n)) {
    if (c.nodeType === ELEMENT && BLOCKS.has(c.nodeName)) {
      flush();
      const md = one(c);
      if (md.trim()) out.push(md);
    } else line += inline(c);
  }
  flush();
  return out;
}

export function htmlToMarkdown(root: MdNode): string {
  return blocks(root).join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
