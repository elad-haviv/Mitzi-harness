// Parses the YAML frontmatter used by SKILL.md, command and agent files. Covers what
// those files use in practice: scalars, quoted strings, block scalars (| and >) and lists.

export interface Parsed {
  data: Record<string, unknown>;
  body: string;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

function scalar(v: string): unknown {
  const t = v.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith('[') && t.endsWith(']')) {
    return t
      .slice(1, -1)
      .split(',')
      .map((x) => unquote(x))
      .filter(Boolean);
  }
  return unquote(t.replace(/\s+#.*$/, ''));
}

export function parseFrontmatter(text: string): Parsed {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!m) return { data: {}, body: normalized };
  const lines = m[1].split('\n');
  const data: Record<string, unknown> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w][\w.-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, rest] = kv;
    const block = /^([|>])([+-]?)\s*$/.exec(rest);
    if (block) {
      const collected: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) collected.push(lines[++i]);
      const indent = Math.min(...collected.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
      const stripped = collected.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      let value =
        block[1] === '|'
          ? stripped.join('\n')
          : stripped
              .join('\n')
              .split(/\n{2,}/)
              .map((p) => p.replace(/\n/g, ' '))
              .join('\n');
      value = block[2] === '+' ? value : value.replace(/\s+$/, '');
      data[key] = value;
    } else if (rest.trim() === '') {
      // A block list or nested map on the following lines.
      const items: string[] = [];
      const nested: Record<string, unknown> = {};
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        const line = lines[++i].trim();
        if (line.startsWith('- ')) items.push(unquote(line.slice(2)));
        else {
          const sub = /^([\w][\w.-]*)\s*:\s*(.*)$/.exec(line);
          if (sub) nested[sub[1]] = scalar(sub[2]);
        }
      }
      data[key] = items.length ? items : Object.keys(nested).length ? nested : '';
    } else {
      data[key] = scalar(rest);
    }
  }
  return { data, body: normalized.slice(m[0].length) };
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : String(v);
}
