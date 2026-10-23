import { Brain, Check, Copy, ExternalLink, FileArchive, Loader2, MessagesSquare, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { parseExport } from '../../../src/shared/importFormats';
import { api, DEFAULT_BOT_ID, ImportedConversation, ImportSource } from '../api';
import { href } from '../router';
import { useApp } from '../state';
import { readZipText } from '../unzip';
import { Modal } from './ui';

const SOURCE_NAME: Record<ImportSource, string> = { chatgpt: 'ChatGPT', claude: 'Claude' };
const BATCH = 25;

/** Brings memories and chat history over from ChatGPT, Claude, Gemini and other assistants. */
export function ImportModal({ initialTab = 'memory', onClose, onDone }: { initialTab?: 'memory' | 'chats'; onClose(): void; onDone?(): void }) {
  const [tab, setTab] = useState(initialTab);
  return (
    <Modal title="Import from another AI" onClose={onClose} wide>
      <div className="segmented" role="tablist" style={{ marginBottom: 16 }}>
        <button role="tab" aria-selected={tab === 'memory'} className={tab === 'memory' ? 'active' : ''} onClick={() => setTab('memory')}>
          <Brain size={14} /> Memories
        </button>
        <button role="tab" aria-selected={tab === 'chats'} className={tab === 'chats' ? 'active' : ''} onClick={() => setTab('chats')}>
          <MessagesSquare size={14} /> Chat history
        </button>
      </div>
      {tab === 'memory' ? <MemoryImport onDone={onDone} /> : <ChatImport onDone={onDone} />}
    </Modal>
  );
}

function BotSelect({ value, onChange }: { value: string; onChange(id: string): void }) {
  const { bots } = useApp();
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 260 }}>
      {bots.map((b) => (
        <option key={b.id} value={b.id}>
          {b.emoji} {b.name}
        </option>
      ))}
    </select>
  );
}

function MemoryImport({ onDone }: { onDone?(): void }) {
  const { toast, bots } = useApp();
  const [prompt, setPrompt] = useState('');
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState('');
  const [items, setItems] = useState<{ text: string; on: boolean }[]>();
  const [botId, setBotId] = useState(DEFAULT_BOT_ID);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number>();
  useEffect(() => {
    api.importPrompt().then((r) => setPrompt(r.prompt), () => {});
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Couldn’t copy; select the text and copy it yourself.');
    }
  };

  const find = async () => {
    setBusy(true);
    try {
      const r = await api.parseMemories(text);
      setItems(r.memories.map((m) => ({ text: m, on: true })));
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const chosen = items!.filter((i) => i.on && i.text.trim()).map((i) => i.text.trim());
    setBusy(true);
    try {
      const r = await api.importMemories(botId, chosen);
      setDone(r.imported);
      onDone?.();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done !== undefined) {
    const bot = bots.find((b) => b.id === botId);
    return (
      <div className="import-done">
        <Check size={28} className="accent" />
        <h3>
          {done} memor{done === 1 ? 'y' : 'ies'} imported into {bot?.name ?? 'Mitzi'}’s memory
        </h3>
        <p className="muted small">They’re used from the next message on. Mitzi also connects them into beliefs about you over the next minute.</p>
        <a className="btn" href={href({ page: 'memory', botId })}>
          Open memory bank
        </a>
      </div>
    );
  }

  if (items) {
    const count = items.filter((i) => i.on && i.text.trim()).length;
    return (
      <>
        <p className="muted small" style={{ marginTop: 0 }}>
          Review what Mitzi found. Edit anything that’s off, and untick what you don’t want remembered.
        </p>
        <div className="import-items">
          {items.map((it, i) => (
            <div key={i} className={`import-item${it.on ? '' : ' off'}`}>
              <input type="checkbox" checked={it.on} aria-label="Import this memory" onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
              <input className="input input-sm" value={it.text} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
              <button className="icon-btn sm" aria-label="Remove" onClick={() => setItems(items.filter((_, j) => j !== i))}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="row import-actions">
          <button className="btn btn-ghost" onClick={() => setItems(undefined)}>
            Back
          </button>
          <span className="grow" />
          <span className="small muted">Save to</span>
          <BotSelect value={botId} onChange={setBotId} />
          <button className="btn btn-primary" disabled={!count || busy} onClick={() => void save()}>
            {busy ? <Loader2 size={14} className="spin" /> : <Brain size={14} />} Import {count} memor{count === 1 ? 'y' : 'ies'}
          </button>
        </div>
      </>
    );
  }

  const q = encodeURIComponent(prompt);
  return (
    <>
      <div className="import-step">
        <span className="step-num">1</span>
        <div className="grow">
          <div className="step-title">Ask your other assistant what it knows about you</div>
          <p className="muted small">Copy this prompt into ChatGPT, Claude, Gemini or any assistant with memory, and send it there.</p>
          <div className="prompt-box">
            <pre>{prompt || 'Loading…'}</pre>
            <button className="btn btn-sm" onClick={() => void copy()} disabled={!prompt}>
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="row small" style={{ gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
            <a href={`https://chatgpt.com/?q=${q}`} target="_blank" rel="noreferrer">
              Open in ChatGPT <ExternalLink size={11} />
            </a>
            <a href={`https://claude.ai/new?q=${q}`} target="_blank" rel="noreferrer">
              Open in Claude <ExternalLink size={11} />
            </a>
            <a href="https://gemini.google.com/app" target="_blank" rel="noreferrer" onClick={() => void copy()}>
              Open Gemini (prompt copied) <ExternalLink size={11} />
            </a>
          </div>
        </div>
      </div>
      <div className="import-step">
        <span className="step-num">2</span>
        <div className="grow">
          <div className="step-title">Paste its answer here</div>
          <textarea className="textarea" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder="- My name is Dana and I live in Haifa&#10;- I work as a nurse and I'm studying for a master's degree&#10;- I prefer short answers with examples…" />
        </div>
      </div>
      <div className="row import-actions">
        <span className="grow" />
        <button className="btn btn-primary" disabled={!text.trim() || busy} onClick={() => void find()}>
          {busy ? <Loader2 size={14} className="spin" /> : null} Find memories
        </button>
      </div>
    </>
  );
}

function ChatImport({ onDone }: { onDone?(): void }) {
  const { toast, refreshChats } = useApp();
  const fileInput = useRef<HTMLInputElement>(null);
  const [found, setFound] = useState<{ source: ImportSource; conversations: ImportedConversation[]; file: string }>();
  const [reading, setReading] = useState(false);
  const [botId, setBotId] = useState(DEFAULT_BOT_ID);
  const [learn, setLearn] = useState(50);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [result, setResult] = useState<{ imported: number; skipped: number; learning: number }>();

  const read = async (file: File) => {
    setReading(true);
    setFound(undefined);
    try {
      const text = /\.zip$/i.test(file.name) || file.type.includes('zip') ? await readZipText(file, 'conversations.json') : await file.text();
      if (!text) throw new Error('No conversations.json in this zip. Use the export from ChatGPT or Claude.');
      const parsed = parseExport(JSON.parse(text));
      if (!parsed.conversations.length) throw new Error('No conversations found in this export.');
      setFound({ ...parsed, file: file.name });
      // Learn from the 50 most recent by default (or all, if there are fewer).
      setLearn(Math.min(50, parsed.conversations.length));
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setReading(false);
    }
  };

  const run = async () => {
    if (!found) return;
    // Newest first, so the ones Mitzi learns from are the most recent.
    const all = [...found.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const totals = { imported: 0, skipped: 0, learning: 0 };
    setProgress({ done: 0, total: all.length });
    try {
      for (let i = 0; i < all.length; i += BATCH) {
        const batch = all.slice(i, i + BATCH);
        // Batches never straddle the learning cut-off.
        const cut = learn - i;
        const parts = cut > 0 && cut < batch.length ? [batch.slice(0, cut), batch.slice(cut)] : [batch];
        for (const part of parts) {
          const r = await api.importChats({ source: found.source, botId, conversations: part, learn: all.indexOf(part[0]) < learn });
          totals.imported += r.imported;
          totals.skipped += r.skipped;
          totals.learning += r.learning;
        }
        setProgress({ done: Math.min(i + BATCH, all.length), total: all.length });
      }
      setResult(totals);
      void refreshChats();
      onDone?.();
    } catch (err) {
      toast((err as Error).message);
      setProgress(undefined);
    }
  };

  if (result) {
    return (
      <div className="import-done">
        <Check size={28} className="accent" />
        <h3>
          {result.imported} conversation{result.imported === 1 ? '' : 's'} imported from {SOURCE_NAME[found!.source]}
        </h3>
        <p className="muted small">
          {result.skipped > 0 && `${result.skipped} were already here or empty. `}
          They’re in your chat list, and you can continue any of them.
          {result.learning > 0 && ` Mitzi is reading the ${result.learning} most recent in the background to learn about you; new memories appear on the Memory page as it goes.`}
        </p>
      </div>
    );
  }

  const dates = found ? found.conversations.map((c) => c.createdAt).sort() : [];
  const fmt = (d?: string) => (d ? new Date(d).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '');
  return (
    <>
      <div className="import-sources">
        <div>
          <strong>ChatGPT</strong>
          <p className="muted small">
            Settings → Data controls → <a href="https://chatgpt.com/#settings/DataControls" target="_blank" rel="noreferrer">Export data</a>. You’ll get an email with a .zip (it can take a while).
          </p>
        </div>
        <div>
          <strong>Claude</strong>
          <p className="muted small">
            Settings → Privacy → <a href="https://claude.ai/settings/data-privacy-controls" target="_blank" rel="noreferrer">Export data</a>. You’ll get an email with a .zip.
          </p>
        </div>
      </div>
      <input ref={fileInput} type="file" accept=".zip,.json,application/zip,application/json" hidden onChange={(e) => e.target.files?.[0] && void read(e.target.files[0])} />
      <button
        className={`dropzone${found ? ' has-file' : ''}`}
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) void read(f);
        }}
      >
        {reading ? <Loader2 size={22} className="spin" /> : found ? <FileArchive size={22} className="accent" /> : <Upload size={22} className="muted" />}
        <span>
          {reading
            ? 'Reading the export…'
            : found
              ? `${found.conversations.length.toLocaleString()} ${SOURCE_NAME[found.source]} conversations, ${fmt(dates[0])} – ${fmt(dates.at(-1))}`
              : 'Drop the export .zip (or conversations.json) here, or click to choose'}
        </span>
        <span className="muted small">{found ? found.file : 'Unpacked on this computer; only the conversations are imported.'}</span>
      </button>
      {found && (
        <div className="import-options">
          <label className="row small">
            <span style={{ width: 150 }}>Continue them with</span>
            <BotSelect value={botId} onChange={setBotId} />
          </label>
          <label className="row small">
            <span style={{ width: 150 }}>Learn about me from</span>
            <select className="select" value={learn} onChange={(e) => setLearn(Number(e.target.value))} style={{ maxWidth: 260 }}>
              <option value={0}>No conversations</option>
              {[25, 50, 100, 250].filter((n) => n < found.conversations.length).map((n) => (
                <option key={n} value={n}>
                  The {n} most recent
                </option>
              ))}
              <option value={found.conversations.length}>All {found.conversations.length.toLocaleString()} conversations</option>
            </select>
          </label>
          <p className="muted small" style={{ margin: 0 }}>
            Learning reads each conversation with your fast model, about one small request per conversation.
          </p>
        </div>
      )}
      {progress && (
        <div className="import-progress" role="progressbar" aria-valuenow={progress.done} aria-valuemax={progress.total}>
          <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
        </div>
      )}
      <div className="row import-actions">
        <span className="grow" />
        <button className="btn btn-primary" disabled={!found || !!progress} onClick={() => void run()}>
          {progress ? (
            <>
              <Loader2 size={14} className="spin" /> Importing {progress.done}/{progress.total}
            </>
          ) : (
            <>Import {found ? found.conversations.length.toLocaleString() : ''} conversations</>
          )}
        </button>
      </div>
    </>
  );
}
