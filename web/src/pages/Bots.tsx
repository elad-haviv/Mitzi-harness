import { Brain, Globe, ImageIcon, Layers, MessageSquare, Pencil, Plug, Plus, ThumbsDown, ThumbsUp, Trash2, Users, WandSparkles, X, Split, Code2, MousePointerClick } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, BankProfile, Bot, BotTools, Lesson } from '../api';
import { ModelPicker } from '../components/ModelPicker';
import { Empty, Modal, Toggle, useConfirm } from '../components/ui';
import { href, navigate } from '../router';
import { modelLabel, useApp } from '../state';
import { tr } from '../i18n';

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
            <h1 className="page-title">{tr('Bots')}</h1>
            <p className="page-subtitle">{tr('Custom assistants with their own instructions, model, tools and conversation starters.')}</p>
          </div>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            <Plus size={16} /> {tr('Create bot')}
          </button>
        </div>
        {bots.length === 0 ? (
          <Empty
            icon={<MessageSquare size={22} />}
            title={tr('No bots yet')}
            action={
              <button className="btn btn-primary" onClick={() => setEditing('new')}>
                <Plus size={16} /> {tr('Create your first bot')}
              </button>
            }
          >
            {tr('A bot is a reusable assistant: a persona and instructions you can start a chat with in one click.')}
          </Empty>
        ) : (
          <div className="grid">
            {bots.map((b) => (
              <div key={b.id} className="tile">
                <div className="tile-actions">
                  <button className="icon-btn sm" aria-label={tr('Edit {0}', b.name)} onClick={() => setEditing(b)}>
                    <Pencil size={14} />
                  </button>
                  {!b.builtIn && !b.pluginId && (
                  <button
                    className="icon-btn sm"
                    aria-label={tr('Delete {0}', b.name)}
                    onClick={async () => {
                      if (!(await confirm(tr('Delete “{0}” and its memory bank? Existing chats are kept and continue with Mitzi.', b.name), { title: tr('Delete bot?') }))) return;
                      await api.deleteBot(b.id).catch((err) => toast(err.message));
                      void refreshBots();
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                  )}
                </div>
                <div className={`bot-emoji${b.builtIn ? ' builtin' : ''}`}>{b.emoji}</div>
                <div className="tile-title row" style={{ gap: 8 }}>
                  {b.name} {b.builtIn && <span className="badge accent">{tr('Default')}</span>}
                  {b.pluginId && <span className="badge">{tr('Plugin')}</span>}
                </div>
                <div className="tile-desc">{b.description || <span className="muted">{tr('No description')}</span>}</div>
                <div className="tile-foot">
                  <span className="badge">{b.model ? modelLabel(b.model, models) : tr('Default model')}</span>
                  {b.tools.web && <Globe size={13} aria-label={tr('Web')} />}
                  {b.tools.artifacts && <Layers size={13} aria-label={tr('Artifacts')} />}
                  {b.tools.connectors && <Plug size={13} aria-label={tr('Connectors')} />}
                  {b.tools.memory && (
                    <a href={href({ page: 'memory', botId: b.id })} title={tr('Memory bank')} className="muted" style={{ display: 'inline-flex' }}>
                      <Brain size={13} aria-label={tr('Memory bank')} />
                    </a>
                  )}
                  <a className="btn btn-sm" style={{ marginLeft: 'auto' }} href={href({ page: 'new', botId: b.id })}>
                    <MessageSquare size={14} /> {tr('Chat')}
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
    tools: { media: true, ...(bot?.tools ?? { artifacts: true, web: true, memory: true, skills: true, connectors: true }) },
    starters: bot?.starters.length ? bot.starters : [''],
    memory: bot?.memory ?? ({ mission: '', disposition: { skepticism: 3, literalism: 3, empathy: 3 }, autoRetain: true } as BankProfile),
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
      title={bot ? tr('Edit {0}', bot.name) : tr('Create a bot')}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn btn-primary" disabled={!form.name.trim() || busy} onClick={save}>
            {bot ? tr('Save changes') : tr('Create bot')}
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">{tr('Icon')}</span>
        <div className="emoji-grid">
          {EMOJIS.map((e) => (
            <button key={e} type="button" className={form.emoji === e ? 'active' : ''} onClick={() => set('emoji', e)} aria-label={tr('Use {0}', e)}>
              {e}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span className="field-label">{tr('Name')}</span>
        <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={tr('e.g. SQL Helper')} autoFocus />
      </label>
      <label className="field">
        <span className="field-label">{tr('Description')}</span>
        <input className="input" value={form.description} onChange={(e) => set('description', e.target.value)} placeholder={tr('What does this bot do?')} />
      </label>
      <label className="field">
        <span className="field-label">{tr('Instructions')}</span>
        <textarea
          className="textarea"
          rows={7}
          value={form.systemPrompt}
          onChange={(e) => set('systemPrompt', e.target.value)}
          placeholder={tr('Describe the bot\'s role, expertise, tone, and any rules it should follow.')}
        />
        <span className="field-hint">{tr('Used as the system prompt for every chat with this bot.')}</span>
      </label>
      <div className="field">
        <span className="field-label">{tr('Model')}</span>
        <ModelPicker value={form.model} onChange={(m) => set('model', m)} variant="input" direction="down" allowEmpty={tr('Default model (from Settings)')} auto />
      </div>
      <div className="field">
        <span className="field-label row" style={{ justifyContent: 'space-between' }}>
          {tr('Temperature')}
          <span className="row small" style={{ fontWeight: 400 }}>
            {tr('Model default')}
            <Toggle label={tr('Use model default temperature')} on={form.temperature === undefined} onChange={(v) => set('temperature', v ? undefined : 0.7)} />
          </span>
        </span>
        {form.temperature !== undefined && (
          <div className="range-row">
            <span className="muted small">{tr('Precise')}</span>
            <input type="range" min={0} max={2} step={0.1} value={form.temperature} onChange={(e) => set('temperature', Number(e.target.value))} />
            <span className="muted small">{tr('Creative')}</span>
            <span className="val">{form.temperature.toFixed(1)}</span>
          </div>
        )}
      </div>
      <div className="field">
        <span className="field-label">{tr('Capabilities')}</span>
        <div className="tool-toggles">
          {(
            [
              ['artifacts', <Layers size={18} key="a" />, tr('Artifacts'), tr('Create documents, code, web pages and diagrams in a side panel')],
              ['web', <Globe size={18} key="w" />, tr('Web fetch'), tr('Read web pages (asks for permission each time)')],
              ['memory', <Brain size={18} key="m" />, tr('Memory bank'), tr('Its own long-term memory: recalls what matters and learns from conversations')],
              ['skills', <WandSparkles size={18} key="s" />, tr('Skills'), tr('Load skills from the Skills page when a task calls for one')],
              ['connectors', <Plug size={18} key="c" />, tr('Connectors'), tr('Use tools from your connectors (MCP servers)')],
              ['media', <ImageIcon size={18} key="i" />, tr('Media'), tr('Generate images, video, speech, sounds and music (set up models in Settings)')],
              ['team', <Users size={18} key="t" />, tr('Team'), tr('Hand parts of a task to your other bots, which work on them in parallel')],
              ['code', <Code2 size={18} key="py" />, tr('Python'), tr('Run Python for calculations, data analysis and charts (in a sandbox, or in the project’s folder)')],
              ['subagents', <Split size={18} key="sa" />, tr('Subagents'), tr('Split focused parts of a task off to copies of itself that work in parallel, each with a clean context')],
              ['browser', <Globe size={18} key="b" />, tr('Browser'), tr('Use a real web browser to read and act on websites (asks before each step)')],
              ['computer', <MousePointerClick size={18} key="pc" />, tr('Computer'), tr('See the screen and use the mouse and keyboard, when computer control is on in Settings (asks before each step)')],
            ] as const
          ).map(([k, icon, t, s]) => (
            <div key={k} className="tool-toggle">
              <span className="muted">{icon}</span>
              <div className="grow">
                <div className="t">{t}</div>
                <div className="s">{s}</div>
              </div>
              <Toggle label={t} on={form.tools[k] !== false} onChange={(v) => setTool(k, v)} />
            </div>
          ))}
        </div>
      </div>
      {form.tools.memory && (
        <div className="field">
          <span className="field-label row" style={{ gap: 6 }}>
            <Brain size={15} /> {tr('Memory bank')}
          </span>
          <div className="card" style={{ padding: 14, boxShadow: 'none' }}>
            <label className="field" style={{ marginBottom: 12 }}>
              <span className="small" style={{ fontWeight: 560 }}>{tr('Mission')}</span>
              <textarea
                className="textarea"
                rows={2}
                style={{ minHeight: 0 }}
                value={form.memory.mission}
                onChange={(e) => set('memory', { ...form.memory, mission: e.target.value })}
                placeholder={tr('What should this bot focus on remembering? e.g. “The user\'s codebases, conventions and recurring bugs.”')}
              />
            </label>
            {(
              [
                ['skepticism', tr('Skepticism'), tr('Trusting'), tr('Skeptical'), 'How much evidence it needs before forming a belief'],
                ['literalism', tr('Literalism'), tr('Flexible'), tr('Literal'), 'Whether it infers beyond what you said'],
                ['empathy', tr('Empathy'), tr('Detached'), tr('Empathetic'), 'How much it notices feelings and wellbeing'],
              ] as const
            ).map(([k, label, low, high, hint]) => (
              <div key={k} style={{ marginBottom: 10 }} title={hint}>
                <div className="row small" style={{ justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 560 }}>{label}</span>
                  <span className="muted">{hint}</span>
                </div>
                <div className="range-row">
                  <span className="muted small" style={{ width: 70 }}>
                    {low}
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={5}
                    step={1}
                    value={form.memory.disposition[k]}
                    aria-label={label}
                    onChange={(e) => set('memory', { ...form.memory, disposition: { ...form.memory.disposition, [k]: Number(e.target.value) } })}
                  />
                  <span className="muted small" style={{ width: 80 }}>
                    {high}
                  </span>
                </div>
              </div>
            ))}
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
              <span className="small">
                <span style={{ fontWeight: 560 }}>{tr('Learn from every conversation')}</span>
                <span className="muted"> {tr('· otherwise it only remembers what you or it explicitly save')}</span>
              </span>
              <Toggle label={tr('Learn automatically')} on={form.memory.autoRetain} onChange={(v) => set('memory', { ...form.memory, autoRetain: v })} />
            </div>
          </div>
        </div>
      )}
      {bot && <LessonsField botId={bot.id} />}
      <div className="field">
        <span className="field-label">{tr('Conversation starters')}</span>
        {form.starters.map((s, i) => (
          <div key={i} className="row">
            <input
              className="input"
              value={s}
              placeholder={tr('A prompt users can click to start')}
              onChange={(e) => set('starters', form.starters.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button className="icon-btn" aria-label={tr('Remove starter')} onClick={() => set('starters', form.starters.filter((_, j) => j !== i))}>
              <X size={15} />
            </button>
          </div>
        ))}
        {form.starters.length < 6 && (
          <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => set('starters', [...form.starters, ''])}>
            <Plus size={14} /> {tr('Add starter')}
          </button>
        )}
      </div>
    </Modal>
  );
}

/** What the bot learned from thumbs up/down ratings. */
function LessonsField({ botId }: { botId: string }) {
  const { toast } = useApp();
  const [lessons, setLessons] = useState<Lesson[]>();
  useEffect(() => {
    api.lessons(botId).then(setLessons, () => setLessons([]));
  }, [botId]);
  if (!lessons?.length) return null;
  return (
    <div className="field">
      <span className="field-label">{tr('Learned from your ratings')}</span>
      <div className="card" style={{ padding: 8, boxShadow: 'none' }}>
        {[...lessons].reverse().map((l) => (
          <div key={l.id} className="row small" style={{ gap: 8, padding: '4px 6px' }}>
            {l.value > 0 ? <ThumbsUp size={13} color="var(--ok)" /> : <ThumbsDown size={13} color="var(--danger)" />}
            <span className="grow">{l.text}</span>
            <button className="icon-btn sm" aria-label={tr('Forget this lesson')} title={tr('Forget')} onClick={() => void api.deleteLesson(botId, l.id).then(setLessons, (e) => toast(e.message))}>
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
      <span className="field-hint">{tr('Rate answers with 👍 or 👎 in any chat; the bot keeps these lessons in mind.')}</span>
    </div>
  );
}
