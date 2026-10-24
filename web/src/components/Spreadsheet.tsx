import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  Download,
  FileSpreadsheet,
  Plus,
  Trash2,
  Upload,
  ChevronRight,
  Columns,
  Rows,
} from 'lucide-react';
import {
  parseSheetWorkbook,
  serializeSheetWorkbook,
  SheetWorkbook,
  workbookToXlsx,
  downloadBlob,
  readSpreadsheetFile,
} from '../office';
import { tr } from '../i18n';

/** Converts 0-indexed column to Excel letters (0 -> 'A', 25 -> 'Z', 26 -> 'AA'). */
export function colToLetter(col: number): string {
  let letter = '';
  let c = col;
  while (c >= 0) {
    letter = String.fromCharCode((c % 26) + 65) + letter;
    c = Math.floor(c / 26) - 1;
  }
  return letter;
}

/** Converts Excel column letter to 0-indexed number ('A' -> 0, 'Z' -> 25, 'AA' -> 26). */
export function letterToCol(letters: string): number {
  return [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

/** Parses cell coordinate like 'A1' into { col: 0, row: 0 }. */
function parseCellCoord(ref: string): { col: number; row: number } | null {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref.trim());
  if (!m) return null;
  return { col: letterToCol(m[1]), row: parseInt(m[2], 10) - 1 };
}

/** Evaluates a basic Excel formula like =SUM(A1:B3) or =A1+B1 given the 2D grid of values. */
export function evaluateFormula(val: string, grid: string[][]): string {
  if (!val.startsWith('=')) return val;
  const expr = val.slice(1).trim();

  // Range function: SUM, AVERAGE, MIN, MAX, COUNT
  const funcMatch = /^([A-Z]+)\(([^)]+)\)$/i.exec(expr);
  if (funcMatch) {
    const fn = funcMatch[1].toUpperCase();
    const arg = funcMatch[2].trim();

    const rangeMatch = /^([A-Z]+\d+):([A-Z]+\d+)$/i.exec(arg);
    if (rangeMatch) {
      const start = parseCellCoord(rangeMatch[1]);
      const end = parseCellCoord(rangeMatch[2]);
      if (start && end) {
        const minR = Math.min(start.row, end.row);
        const maxR = Math.max(start.row, end.row);
        const minC = Math.min(start.col, end.col);
        const maxC = Math.max(start.col, end.col);

        const nums: number[] = [];
        for (let r = minR; r <= maxR; r++) {
          for (let c = minC; c <= maxC; c++) {
            const raw = grid[r]?.[c] ?? '';
            const evaled = raw.startsWith('=') ? evaluateFormula(raw, grid) : raw;
            const n = parseFloat(evaled);
            if (!isNaN(n)) nums.push(n);
          }
        }

        if (fn === 'SUM') return String(nums.reduce((a, b) => a + b, 0));
        if (fn === 'AVERAGE') return nums.length ? String(nums.reduce((a, b) => a + b, 0) / nums.length) : '0';
        if (fn === 'MIN') return nums.length ? String(Math.min(...nums)) : '0';
        if (fn === 'MAX') return nums.length ? String(Math.max(...nums)) : '0';
        if (fn === 'COUNT') return String(nums.length);
      }
    }
  }

  // Simple arithmetic expression with cell coordinates e.g. A1 + B2
  try {
    const resolved = expr.replace(/[A-Z]+\d+/gi, (cellRef) => {
      const coord = parseCellCoord(cellRef);
      if (!coord) return '0';
      const raw = grid[coord.row]?.[coord.col] ?? '0';
      const evaluated = raw.startsWith('=') ? evaluateFormula(raw, grid) : raw;
      const num = parseFloat(evaluated);
      return isNaN(num) ? '0' : String(num);
    });

    if (/^[0-9+\-*/().\s]+$/.test(resolved)) {
      // Safe arithmetic calculation
      const res = Function(`"use strict"; return (${resolved})`)();
      return typeof res === 'number' && !isNaN(res) ? String(Math.round(res * 1000000) / 1000000) : '#VALUE!';
    }
  } catch {
    return '#ERROR!';
  }

  return val;
}

export function Spreadsheet({
  value,
  onChange,
  readOnly,
  title = 'Spreadsheet',
}: {
  value: string;
  onChange?(next: string): void;
  readOnly?: boolean;
  title?: string;
}) {
  const workbook = useMemo(() => parseSheetWorkbook(value), [value]);
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const [activeCell, setActiveCell] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentSheet = workbook.sheets[activeSheetIdx] || workbook.sheets[0] || { name: 'Sheet1', rows: [['']] };
  const rows = currentSheet.rows;

  const numRows = Math.max(rows.length, 12);
  const maxColsInRows = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const numCols = Math.max(maxColsInRows, 8);

  const getCellRaw = useCallback(
    (r: number, c: number): string => {
      return rows[r]?.[c] ?? '';
    },
    [rows],
  );

  const evaluatedGrid = useMemo(() => {
    return Array.from({ length: numRows }, (_, r) =>
      Array.from({ length: numCols }, (_, c) => {
        const raw = rows[r]?.[c] ?? '';
        return raw.startsWith('=') ? evaluateFormula(raw, rows) : raw;
      }),
    );
  }, [rows, numRows, numCols]);

  const updateWorkbook = (newWb: SheetWorkbook) => {
    if (onChange) {
      onChange(serializeSheetWorkbook(newWb));
    }
  };

  const setCell = (r: number, c: number, val: string) => {
    if (readOnly) return;
    const newSheets = [...workbook.sheets];
    const sheet = { ...newSheets[activeSheetIdx] };
    const newRows = sheet.rows.map((row) => [...row]);

    while (newRows.length <= r) {
      newRows.push([]);
    }
    while (newRows[r].length <= c) {
      newRows[r].push('');
    }

    newRows[r][c] = val;
    sheet.rows = newRows;
    newSheets[activeSheetIdx] = sheet;
    updateWorkbook({ sheets: newSheets });
  };

  const handleCellClick = (r: number, c: number) => {
    if (editing) {
      setCell(activeCell.row, activeCell.col, editValue);
      setEditing(false);
    }
    setActiveCell({ row: r, col: c });
  };

  const handleCellDoubleClick = (r: number, c: number) => {
    if (readOnly) return;
    setActiveCell({ row: r, col: c });
    setEditValue(getCellRaw(r, c));
    setEditing(true);
  };

  const handleFormulaChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (readOnly) return;
    setCell(activeCell.row, activeCell.col, e.target.value);
  };

  const addRow = () => {
    if (readOnly) return;
    const newSheets = [...workbook.sheets];
    const sheet = { ...newSheets[activeSheetIdx] };
    sheet.rows = [...sheet.rows, Array.from({ length: numCols }, () => '')];
    newSheets[activeSheetIdx] = sheet;
    updateWorkbook({ sheets: newSheets });
  };

  const addCol = () => {
    if (readOnly) return;
    const newSheets = [...workbook.sheets];
    const sheet = { ...newSheets[activeSheetIdx] };
    sheet.rows = sheet.rows.map((r) => [...r, '']);
    newSheets[activeSheetIdx] = sheet;
    updateWorkbook({ sheets: newSheets });
  };

  const deleteRow = () => {
    if (readOnly || rows.length <= 1) return;
    const newSheets = [...workbook.sheets];
    const sheet = { ...newSheets[activeSheetIdx] };
    sheet.rows = sheet.rows.filter((_, idx) => idx !== activeCell.row);
    newSheets[activeSheetIdx] = sheet;
    updateWorkbook({ sheets: newSheets });
  };

  const deleteCol = () => {
    if (readOnly || numCols <= 1) return;
    const newSheets = [...workbook.sheets];
    const sheet = { ...newSheets[activeSheetIdx] };
    sheet.rows = sheet.rows.map((r) => r.filter((_, idx) => idx !== activeCell.col));
    newSheets[activeSheetIdx] = sheet;
    updateWorkbook({ sheets: newSheets });
  };

  const addSheet = () => {
    if (readOnly) return;
    const newName = `Sheet${workbook.sheets.length + 1}`;
    const newSheets = [...workbook.sheets, { name: newName, rows: [['', '', ''], ['', '', '']] }];
    updateWorkbook({ sheets: newSheets });
    setActiveSheetIdx(newSheets.length - 1);
  };

  const handleDownloadXlsx = () => {
    const blob = workbookToXlsx(workbook);
    const fname = `${(title || 'spreadsheet').replace(/[^\w.-]+/g, '_')}.xlsx`;
    downloadBlob(blob, fname);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const imported = readSpreadsheetFile(buffer);
      updateWorkbook(imported);
      setActiveSheetIdx(0);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const activeCoordStr = `${colToLetter(activeCell.col)}${activeCell.row + 1}`;
  const activeRawVal = getCellRaw(activeCell.row, activeCell.col);

  return (
    <div className="spreadsheet-container">
      {/* Spreadsheet Toolbar */}
      <div className="sheet-toolbar">
        <div className="sheet-cell-ref">{activeCoordStr}</div>
        <div className="sheet-formula-bar">
          <span className="sheet-fx">fx</span>
          <input
            type="text"
            className="sheet-formula-input"
            value={editing ? editValue : activeRawVal}
            readOnly={readOnly}
            placeholder={tr('Enter a value or formula (=SUM(A1:B5))')}
            onChange={(e) => {
              if (editing) {
                setEditValue(e.target.value);
              } else {
                handleFormulaChange(e);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (editing) {
                  setCell(activeCell.row, activeCell.col, editValue);
                  setEditing(false);
                }
              }
            }}
          />
        </div>

        {!readOnly && (
          <div className="sheet-actions">
            <button type="button" className="icon-btn sm" onClick={addRow} title={tr('Add row')}>
              <Rows size={14} /> +
            </button>
            <button type="button" className="icon-btn sm" onClick={addCol} title={tr('Add column')}>
              <Columns size={14} /> +
            </button>
            <button type="button" className="icon-btn sm" onClick={deleteRow} title={tr('Delete selected row')}>
              <Trash2 size={13} /> {tr('Row')}
            </button>
            <button type="button" className="icon-btn sm" onClick={deleteCol} title={tr('Delete selected column')}>
              <Trash2 size={13} /> {tr('Col')}
            </button>
          </div>
        )}

        <div style={{ flex: 1 }} />

        <div className="sheet-export-buttons">
          {!readOnly && (
            <>
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={handleImportFile} />
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => fileInputRef.current?.click()}
                title={tr('Import .xlsx or .csv')}
              >
                <Upload size={13} /> {tr('Import')}
              </button>
            </>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={handleDownloadXlsx}
            title={tr('Download as Excel workbook (.xlsx)')}
          >
            <Download size={13} /> {tr('Excel (.xlsx)')}
          </button>
        </div>
      </div>

      {/* Main Grid View */}
      <div className="sheet-grid-wrapper">
        <table className="sheet-grid-table">
          <thead>
            <tr>
              <th className="sheet-corner-cell"></th>
              {Array.from({ length: numCols }, (_, c) => (
                <th key={c} className={`sheet-col-header ${c === activeCell.col ? 'active' : ''}`}>
                  {colToLetter(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: numRows }, (_, r) => (
              <tr key={r}>
                <th className={`sheet-row-header ${r === activeCell.row ? 'active' : ''}`}>{r + 1}</th>
                {Array.from({ length: numCols }, (_, c) => {
                  const isSelected = r === activeCell.row && c === activeCell.col;
                  const isCurrentlyEditing = isSelected && editing;
                  const displayVal = evaluatedGrid[r]?.[c] ?? '';

                  return (
                    <td
                      key={c}
                      className={`sheet-cell ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleCellClick(r, c)}
                      onDoubleClick={() => handleCellDoubleClick(r, c)}
                    >
                      {isCurrentlyEditing ? (
                        <input
                          autoFocus
                          className="sheet-inline-input"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => {
                            setCell(r, c, editValue);
                            setEditing(false);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              setCell(r, c, editValue);
                              setEditing(false);
                            } else if (e.key === 'Escape') {
                              setEditing(false);
                            }
                          }}
                        />
                      ) : (
                        <div className="sheet-cell-value">{displayVal}</div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Sheet Tabs Bar */}
      <div className="sheet-tabs-bar">
        {workbook.sheets.map((sheet, idx) => (
          <button
            key={idx}
            type="button"
            className={`sheet-tab-btn ${idx === activeSheetIdx ? 'active' : ''}`}
            onClick={() => {
              setActiveSheetIdx(idx);
              setActiveCell({ row: 0, col: 0 });
            }}
          >
            <FileSpreadsheet size={13} /> {sheet.name}
          </button>
        ))}
        {!readOnly && (
          <button type="button" className="sheet-tab-add" onClick={addSheet} title={tr('Add new sheet')}>
            <Plus size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
