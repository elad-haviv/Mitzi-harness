import { useEffect, useRef, useState } from 'react';
import { Download, FileText, Loader2, X } from 'lucide-react';
import { renderDocx, downloadBlob } from '../office';
import { tr } from '../i18n';

export function DocxViewer({
  data,
  filename = 'Document.docx',
  onClose,
}: {
  data: ArrayBuffer | Blob;
  filename?: string;
  onClose?(): void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!containerRef.current) return;

    setLoading(true);
    setError(null);

    renderDocx(data, containerRef.current)
      .then(() => {
        if (active) setLoading(false);
      })
      .catch((err) => {
        if (active) {
          setError((err as Error).message || tr('Failed to render Word document'));
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [data]);

  const handleDownload = () => {
    const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    downloadBlob(blob, filename);
  };

  return (
    <div className="docx-viewer-wrapper">
      <div className="docx-viewer-header">
        <div className="docx-viewer-title">
          <FileText size={16} />
          <span>{filename}</span>
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={handleDownload}
          title={tr('Download original Word document')}
        >
          <Download size={14} /> {tr('Download')}
        </button>
        {onClose && (
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label={tr('Close')}>
            <X size={16} />
          </button>
        )}
      </div>

      <div className="docx-viewer-body">
        {loading && (
          <div className="docx-viewer-loading">
            <Loader2 size={24} className="spin" />
            <span>{tr('Rendering Word document…')}</span>
          </div>
        )}
        {error && <div className="docx-viewer-error">{error}</div>}
        <div ref={containerRef} className="docx-viewer-content" />
      </div>
    </div>
  );
}
