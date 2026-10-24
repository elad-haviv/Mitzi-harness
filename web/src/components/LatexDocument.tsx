import React, { useMemo, useRef } from 'react';
import katex from 'katex';
import { Download, Printer, Sigma, FileText, Copy, Check } from 'lucide-react';
import { tr } from '../i18n';
import { downloadBlob } from '../office';

/** Renders LaTeX math safely to an HTML string. */
function renderMath(formula: string, displayMode: boolean): string {
  try {
    return katex.renderToString(formula.trim(), {
      displayMode,
      throwOnError: false,
      output: 'htmlAndMathml',
    });
  } catch (err) {
    return `<span class="katex-error">${(err as Error).message}</span>`;
  }
}

/** Parses standard inline LaTeX commands like \textbf{}, \textit{}, \texttt{}, and $math$. */
function parseInlineLatex(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  // Regex for inline math $...$, \(...\), and text formats \textbf, \textit, \emph, \texttt, \underline
  const regex = /(\$([^\$]+)\$)|(\\\(([\s\S]*?)\\\))|\\textbf\{([^{}]+)\}|\\textit\{([^{}]+)\}|\\emph\{([^{}]+)\}|\\texttt\{([^{}]+)\}|\\underline\{([^{}]+)\}|\\href\{([^{}]+)\}\{([^{}]+)\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<span key={key++}>{text.slice(lastIndex, match.index)}</span>);
    }

    if (match[1]) {
      // Inline math $...$
      const html = renderMath(match[2], false);
      nodes.push(<span key={key++} className="latex-inline-math" dangerouslySetInnerHTML={{ __html: html }} />);
    } else if (match[3]) {
      // Inline math \(...\)
      const html = renderMath(match[4], false);
      nodes.push(<span key={key++} className="latex-inline-math" dangerouslySetInnerHTML={{ __html: html }} />);
    } else if (match[5]) {
      // \textbf
      nodes.push(<strong key={key++}>{match[5]}</strong>);
    } else if (match[6] || match[7]) {
      // \textit or \emph
      nodes.push(<em key={key++}>{match[6] || match[7]}</em>);
    } else if (match[8]) {
      // \texttt
      nodes.push(<code key={key++}>{match[8]}</code>);
    } else if (match[9]) {
      // \underline
      nodes.push(<u key={key++}>{match[9]}</u>);
    } else if (match[10]) {
      // \href{url}{text}
      nodes.push(
        <a key={key++} href={match[10]} target="_blank" rel="noopener noreferrer">
          {match[11]}
        </a>,
      );
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(<span key={key++}>{text.slice(lastIndex)}</span>);
  }

  return nodes.length > 0 ? nodes : [<span key={0}>{text}</span>];
}

interface ParsedDoc {
  title?: string;
  author?: string;
  date?: string;
  abstract?: string;
  blocks: DocBlock[];
}

type DocBlock =
  | { type: 'section'; level: number; title: string; number?: string }
  | { type: 'paragraph'; text: string }
  | { type: 'equation'; formula: string; numbered?: boolean; label?: string }
  | { type: 'itemize'; items: string[] }
  | { type: 'enumerate'; items: string[] }
  | { type: 'table'; rows: string[][] }
  | { type: 'environment'; name: string; content: string };

/** Parses full LaTeX document structure. */
export function parseLatex(latex: string): ParsedDoc {
  const doc: ParsedDoc = { blocks: [] };

  // Title, author, date
  const titleM = /\\title\{([^{}]+)\}/.exec(latex);
  if (titleM) doc.title = titleM[1].trim();

  const authorM = /\\author\{([^{}]+)\}/.exec(latex);
  if (authorM) doc.author = authorM[1].trim();

  const dateM = /\\date\{([^{}]+)\}/.exec(latex);
  if (dateM) doc.date = dateM[1].trim();

  // Abstract
  const abstractM = /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/.exec(latex);
  if (abstractM) doc.abstract = abstractM[1].trim();

  // Extract body content between \begin{document} and \end{document} if present
  let body = latex;
  const docEnvM = /\\begin\{document\}([\s\S]*?)(\\end\{document\}|$)/.exec(latex);
  if (docEnvM) {
    body = docEnvM[1];
  }

  // Remove abstract, title, author, date from body if already extracted
  body = body
    .replace(/\\maketitle/g, '')
    .replace(/\\begin\{abstract\}[\s\S]*?\\end\{abstract\}/g, '')
    .replace(/\\title\{[^{}]+\}/g, '')
    .replace(/\\author\{[^{}]+\}/g, '')
    .replace(/\\date\{[^{}]+\}/g, '')
    .trim();

  // Parse lines & environments into blocks
  const lines = body.split(/\r?\n/);
  let i = 0;
  let secIdx = 1;
  let subSecIdx = 1;
  let eqIdx = 1;

  while (i < lines.length) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    if (!line || line.startsWith('%')) {
      i++;
      continue;
    }

    // Sections
    const secM = /\\section\*?\{([^{}]+)\}/.exec(line);
    if (secM) {
      doc.blocks.push({ type: 'section', level: 1, title: secM[1], number: `${secIdx++}.` });
      subSecIdx = 1;
      i++;
      continue;
    }

    const subSecM = /\\subsection\*?\{([^{}]+)\}/.exec(line);
    if (subSecM) {
      doc.blocks.push({ type: 'section', level: 2, title: subSecM[1], number: `${secIdx - 1}.${subSecIdx++}` });
      i++;
      continue;
    }

    const subSubSecM = /\\subsubsection\*?\{([^{}]+)\}/.exec(line);
    if (subSubSecM) {
      doc.blocks.push({ type: 'section', level: 3, title: subSubSecM[1] });
      i++;
      continue;
    }

    // Math block: \begin{equation}, \begin{align}, \begin{gather}, etc.
    const mathEnvStart = /^\\begin\{(equation|align|gather|multline|split)\*?\}/.exec(line);
    if (mathEnvStart) {
      const envName = mathEnvStart[1];
      let formula = line;
      i++;
      while (i < lines.length && !lines[i].includes(`\\end{${envName}`)) {
        formula += '\n' + lines[i];
        i++;
      }
      if (i < lines.length) {
        formula += '\n' + lines[i];
        i++;
      }
      doc.blocks.push({
        type: 'equation',
        formula,
        numbered: !envName.endsWith('*'),
        label: `(${eqIdx++})`,
      });
      continue;
    }

    // Math block: \[ ... \] or $$ ... $$
    if (line.startsWith('\\[') || line.startsWith('$$')) {
      const endMarker = line.startsWith('\\[') ? '\\]' : '$$';
      let formula = line;
      if (!line.endsWith(endMarker) || line === '\\[' || line === '$$') {
        i++;
        while (i < lines.length && !lines[i].includes(endMarker)) {
          formula += '\n' + lines[i];
          i++;
        }
        if (i < lines.length) {
          formula += '\n' + lines[i];
          i++;
        }
      } else {
        i++;
      }
      const clean = formula.replace(/^\\\[|\\\]$|^\$\$|\$\$$/g, '').trim();
      doc.blocks.push({ type: 'equation', formula: clean, numbered: false });
      continue;
    }

    // Lists: itemize / enumerate
    if (line.startsWith('\\begin{itemize}') || line.startsWith('\\begin{enumerate}')) {
      const isOrdered = line.startsWith('\\begin{enumerate}');
      const endTag = isOrdered ? '\\end{enumerate}' : '\\end{itemize}';
      const items: string[] = [];
      let currentItem = '';
      i++;
      while (i < lines.length && !lines[i].includes(endTag)) {
        const itemLine = lines[i].trim();
        if (itemLine.startsWith('\\item')) {
          if (currentItem) items.push(currentItem);
          currentItem = itemLine.replace(/^\\item\s*/, '');
        } else if (currentItem) {
          currentItem += ' ' + itemLine;
        }
        i++;
      }
      if (currentItem) items.push(currentItem);
      if (i < lines.length) i++;
      doc.blocks.push(isOrdered ? { type: 'enumerate', items } : { type: 'itemize', items });
      continue;
    }

    // Table: tabular
    if (line.includes('\\begin{tabular}')) {
      const rows: string[][] = [];
      i++;
      while (i < lines.length && !lines[i].includes('\\end{tabular}')) {
        const tLine = lines[i].trim();
        if (tLine && !tLine.startsWith('\\hline')) {
          const cells = tLine.replace(/\\\\.*$/, '').split('&').map((c) => c.trim());
          rows.push(cells);
        }
        i++;
      }
      if (i < lines.length) i++;
      doc.blocks.push({ type: 'table', rows });
      continue;
    }

    // Other environments (theorem, definition, proof, quote)
    const envM = /^\\begin\{([a-zA-Z]+)\}/.exec(line);
    if (envM) {
      const eName = envM[1];
      let eContent = '';
      i++;
      while (i < lines.length && !lines[i].includes(`\\end{${eName}}`)) {
        eContent += lines[i] + '\n';
        i++;
      }
      if (i < lines.length) i++;
      doc.blocks.push({ type: 'environment', name: eName, content: eContent.trim() });
      continue;
    }

    // Regular paragraph (accumulate until blank line or special block)
    let pText = line;
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith('\\') &&
      !lines[i].trim().startsWith('%') &&
      !lines[i].trim().startsWith('$$')
    ) {
      pText += ' ' + lines[i].trim();
      i++;
    }
    doc.blocks.push({ type: 'paragraph', text: pText });
  }

  return doc;
}

export function LatexDocument({
  value,
  title = 'LaTeX Document',
}: {
  value: string;
  title?: string;
}) {
  const doc = useMemo(() => parseLatex(value), [value]);
  const paperRef = useRef<HTMLDivElement>(null);

  const handlePrint = () => {
    window.print();
  };

  const handleDownloadTex = () => {
    const blob = new Blob([value], { type: 'text/plain;charset=utf-8' });
    const fname = `${(doc.title || title || 'document').replace(/[^\w.-]+/g, '_')}.tex`;
    downloadBlob(blob, fname);
  };

  return (
    <div className="latex-viewer-container">
      {/* Action Header */}
      <div className="latex-action-bar no-print">
        <div className="latex-doc-meta">
          <Sigma size={15} />
          <span>{doc.title || title}</span>
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={handlePrint}
          title={tr('Print document or save as PDF')}
        >
          <Printer size={14} /> {tr('Print / PDF')}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={handleDownloadTex}
          title={tr('Download source LaTeX file (.tex)')}
        >
          <Download size={14} /> {tr('Download .tex')}
        </button>
      </div>

      {/* Formatted Paper View */}
      <div className="latex-paper-scroll">
        <article ref={paperRef} className="latex-paper">
          {/* Header */}
          {(doc.title || title) && <h1 className="latex-title">{doc.title || title}</h1>}
          {doc.author && <div className="latex-author">{doc.author}</div>}
          {doc.date && <div className="latex-date">{doc.date}</div>}

          {/* Abstract */}
          {doc.abstract && (
            <div className="latex-abstract">
              <div className="latex-abstract-title">{tr('Abstract')}</div>
              <p>{parseInlineLatex(doc.abstract)}</p>
            </div>
          )}

          {/* Document Content */}
          <div className="latex-body">
            {doc.blocks.map((block, idx) => {
              switch (block.type) {
                case 'section':
                  return (
                    <div key={idx} className={`latex-section latex-sec-${block.level}`}>
                      {block.level === 1 ? (
                        <h2>
                          {block.number && <span className="latex-sec-num">{block.number} </span>}
                          {parseInlineLatex(block.title)}
                        </h2>
                      ) : block.level === 2 ? (
                        <h3>
                          {block.number && <span className="latex-sec-num">{block.number} </span>}
                          {parseInlineLatex(block.title)}
                        </h3>
                      ) : (
                        <h4>{parseInlineLatex(block.title)}</h4>
                      )}
                    </div>
                  );

                case 'paragraph':
                  return <p key={idx} className="latex-p">{parseInlineLatex(block.text)}</p>;

                case 'equation':
                  return (
                    <div key={idx} className="latex-equation-row">
                      <div
                        className="latex-equation-math"
                        dangerouslySetInnerHTML={{ __html: renderMath(block.formula, true) }}
                      />
                      {block.label && <span className="latex-equation-label">{block.label}</span>}
                    </div>
                  );

                case 'itemize':
                  return (
                    <ul key={idx} className="latex-ul">
                      {block.items.map((it, iIdx) => (
                        <li key={iIdx}>{parseInlineLatex(it)}</li>
                      ))}
                    </ul>
                  );

                case 'enumerate':
                  return (
                    <ol key={idx} className="latex-ol">
                      {block.items.map((it, iIdx) => (
                        <li key={iIdx}>{parseInlineLatex(it)}</li>
                      ))}
                    </ol>
                  );

                case 'table':
                  return (
                    <div key={idx} className="latex-table-wrapper">
                      <table className="latex-table">
                        <tbody>
                          {block.rows.map((row, rIdx) => (
                            <tr key={rIdx}>
                              {row.map((cell, cIdx) => (
                                <td key={cIdx}>{parseInlineLatex(cell)}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );

                case 'environment':
                  return (
                    <div key={idx} className={`latex-env latex-env-${block.name.toLowerCase()}`}>
                      <div className="latex-env-name">
                        <strong>{block.name.toUpperCase()}</strong>
                      </div>
                      <div className="latex-env-content">{parseInlineLatex(block.content)}</div>
                    </div>
                  );

                default:
                  return null;
              }
            })}
          </div>
        </article>
      </div>
    </div>
  );
}
