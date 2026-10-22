import { Brain, Globe, Layers, MessageSquare, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { api, Bot, BotTools } from '../api';
import { ModelPicker } from '../components/ModelPicker';
import { Empty, Modal, Toggle, useConfirm } from '../components/ui';
import { href, navigate } from '../router';
import { modelLabel, useApp } from '../state';

const EMOJIS = ['🤖', '🧐', '✍️', '🦉', '🧠', '🧪', '📈', '🎨', '🧑‍🍳', '🧭', '🛠️', '📚', '🐱', '🦊', '🌱', '🚀', '⚖️', '🎵', '🗺️', '💡'];

export function BotsPage() {
  const { bots, refreshBots, models, toast } = useApp();
  const [editing, setEditing] = useState<Bot | 'new'>();
  const [confirmNode, confirm] = useConfirm();

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">Bots</h1>
            <p className="page-subtitle">Custom assistants with their own instructions, model, tools and conversation starters.</p>
          </div>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            <Plus size={16} /> Create bot
          </button>
        </div>
        {bots.length === 0 ? (
          <Empty
            icon={<MessageSquare size={22} />}
            title="No bots yet"
            action={
              <button className="btn btn-primary" onClick={() => setEditing('new')}>
                <Plus size={16} /> Create your first bot
              </button>
            }
          >
            A bot is a reusable assistant: a persona and instructions you can start a chat with in one click.
          </Empty>
        ) : (
          <div className="grid">
            {bots.map((b) => (
              <div key={b.id} className="tile">
                <div className="tile-actions">
                  <button className="icon-btn sm" aria-label={`Edit ${b.name}`} onClick={() => setEditing(b)}>
                    <Pencil size={14} />
                  </button>
                  <button
                    className="icon-btn sm"
                    aria-label={`Delete ${b.name}`}
                    onClick={async () => {
                      if (!(await confirm(`Delete the bot “${b.name}”? Existing chats with it are kept.`, { title: 'Delete bot?' }))) return;
                      await api.deleteBot(b.id).catch((err) => toast(err.message));
                      void refreshBots();
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="bot-emoji">{b.emoji}</div>
                <div className="tile-title">{b.name}</div>
                <div className="tile-desc">{b.description || <span className="muted">No description</span>}</div>
                <div className="tile-foot">
                  <span className="badge">{b.model ? modelLabel(b.model, models) : 'Default model'}</span>
                  {b.tools.web && <Globe size={13} aria-label="Web" />}
                  {b.tools.artifacts && <Layers size={13} aria-label="Artifacts" />}
                  {b.tools.memory && <Brain size={13} aria-label="Memory" />}
                  <a className="btn btn-sm" style={{ marginLeft: 'auto' }} href={href({ page: 'new', botId: b.id })}>
                    <MessageSquare size={14} /> Chat
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {editing && (
        <BotEditor
          bot={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={(b, isNew) => {
            void refreshBots();
            if (isNew) navigate({ page: 'new', botId: b.id });
          }}
        />
      )}
      {confirmNode}
    </div>
  );
}

function BotEditor({ bot, onClose, onSaved }: { bot?: Bot; onClose(): void; onSaved(b: Bot, isNew: boolean): void }) {
  const { toast } = useApp();
  const [form, setForm] = useState({
    name: bot?.name ?? '',
    emoji: bot?.emoji ?? '🤖',
    description: bot?.description ?? '',
    systemPrompt: bot?.systemPrompt ?? '',
    model: bot?.model ?? '',
    temperature: bot?.temperature,
    tools: bot?.tools ?? { artifacts: true, web: true, memory: true },
    starters: bot?.starters.length ? bot.starters : [''],
  });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setTool = (k: keyof BotTools, v: boolean) => set('tools', { ...form.tools, [k]: v });

  const save = async () => {
    setBusy(true);
    try {
      const body = { ...form, starters: form.starters.filter((s) => s.trim()), temperature: form.temperature ?? null } as unknown as Partial<Bot>;
      const saved = bot ? await api.updateBot(bot.id, body) : await api.createBot(body);
      onSaved(saved, !bot);
      onClose();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={bot ? `Edit ${bot.name}` : 'Create a bot'}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!form.name.trim() || busy} onClick={save}>
            {bot ? 'Save changes' : 'Create bot'}
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">Icon</span>
        <div className="emoji-grid">
          {EMOJIS.map((e) => (
            <button key={e} type="button" className={form.emoji === e ? 'active' : ''} onClick={() => set('emoji', e)} aria-label={`Use ${e}`}>
              {e}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span className="field-label">Name</span>
        <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. SQL Helper" autoFocus />
      </label>
      <label className="field">
        <span className="field-label">Description</span>
        <input className="input" value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="What does this bot do?" />
      </label>
      <label className="field">
        <span className="field-label">Instructions</span>
        <textarea
          className="textarea"
          rows={7}
          value={form.systemPrompt}
          onChange={(e) => set('systemPrompt', e.target.value)}
          placeholder="Describe the bot's role, expertise, tone, and any rules it should follow."
        />
        <span className="field-hint">Used as the system prompt for every chat with this bot.</span>
      </label>
      <div className="field">
        <span className="field-label">Model</span>
        <ModelPicker value={form.model} onChange={(m) => set('model', m)} variant="input" direction="down" allowEmpty="Default model (from Settings)" />
      </div>
      <div className="field">
        <span className="field-label row" style={{ justifyContent: 'space-between' }}>
          Temperature
          <span className="row small" style={{ fontWeight: 400 }}>
            Model default
            <Toggle label="Use model default temperature" on={form.temperature === undefined} onChange={(v) => set('temperature', v ? undefined : 0.7)} />
          </span>
        </span>
        {form.temperature !== undefined && (
          <div className="range-row">
            <span className="muted small">Precise</span>
            <input type="range" min={0} max={2} step={0.1} value={form.temperature} onChange={(e) => set('temperature', Number(e.target.value))} />
            <span className="muted small">Creative</span>
            <span className="val">{form.temperature.toFixed(1)}</span>
          </div>
        )}
      </div>
      <div className="field">
        <span className="field-label">Capabilities</span>
        <div className="tool-toggles">
          {(
            [
              ['artifacts', <Layers size={18} key="a" />, 'Artifacts', 'Create documents, code, web pages and diagrams in a side panel'],
              ['web', <Globe size={18} key="w" />, 'Web fetch', 'Read web pages (asks for permission each time)'],
              ['memory', <Brain size={18} key="m" />, 'Memory', 'Remember facts about you across conversations'],
            ] as const
          ).map(([k, icon, t, s]) => (
            <div key={k} className="tool-toggle">
              <span className="muted">{icon}</span>
              <div className="grow">
                <div className="t">{t}</div>
                <div className="s">{s}</div>
              </div>
              <Toggle label={t} on={form.tools[k]} onChange={(v) => setTool(k, v)} />
            </div>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label">Conversation starters</span>
        {form.starters.map((s, i) => (
          <div key={i} className="row">
            <input
              className="input"
              value={s}
              placeholder="A prompt users can click to start"
              onChange={(e) => set('starters', form.starters.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button className="icon-btn" aria-label="Remove starter" onClick={() => set('starters', form.starters.filter((_, j) => j !== i))}>
              <X size={15} />
            </button>
          </div>
        ))}
        {form.starters.length < 6 && (
          <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => set('starters', [...form.starters, ''])}>
            <Plus size={14} /> Add starter
          </button>
        )}
      </div>
    </Modal>
  );
}
