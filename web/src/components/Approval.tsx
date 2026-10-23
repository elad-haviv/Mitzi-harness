// Approval levels, named for cats: how much a bot may do before it asks.
import { Check, ChevronDown } from 'lucide-react';
import type { ApprovalLevel, ChatListItem, ProjectView, PublicSettings } from '../api';
import { Menu } from './ui';
import { tr } from '../i18n';

export const APPROVAL: Record<ApprovalLevel, { emoji: string; name: string; short: string; description: string }> = {
  kitten: {
    emoji: '🐱',
    name: tr('Kitten'),
    short: 'Asks before every change',
    description: tr('Asks before every command, file edit, web request and action in a connected app.'),
  },
  housecat: {
    emoji: '🐈',
    name: 'House cat',
    short: 'Asks only before risky actions',
    description: tr('Works on its own, but asks before deleting, installing, pushing, changing the system, writing outside the project or acting in connected apps.'),
  },
  alleycat: {
    emoji: '🐈‍⬛',
    name: 'Alley cat',
    short: 'Never asks',
    description: tr('Fully autonomous: runs commands, edits files and acts in connected apps without asking. Use it for work you trust.'),
  },
};

export const LEVELS = Object.keys(APPROVAL) as ApprovalLevel[];

/** The level a chat runs at: its own, else its project's permissions, else the default from Settings (as the server decides). */
export function approvalOf(chat: Pick<ChatListItem, 'approval'> | undefined, project: ProjectView | undefined, settings: PublicSettings | undefined): ApprovalLevel {
  if (chat?.approval) return chat.approval;
  if (project?.permissionMode === 'yolo') return 'alleycat';
  if (project?.permissionMode === 'sensitive') return 'housecat';
  return settings?.approval ?? 'kitten';
}

export const nextLevel = (level: ApprovalLevel) => LEVELS[(LEVELS.indexOf(level) + 1) % LEVELS.length];

/** The composer chip that shows and changes the approval level. */
export function ApprovalPicker({ level, onChange, planOnly }: { level: ApprovalLevel; onChange(level: ApprovalLevel): void; planOnly?: boolean }) {
  const info = APPROVAL[level];
  return (
    <Menu
      align="left"
      direction="up"
      trigger={(_open, toggle) => (
        <button
          type="button"
          className={`pill-btn approval-chip ${level}`}
          onClick={toggle}
          title={planOnly ? tr('This project is in plan mode: read-only, whatever the level') : tr('{0}: {1} (Shift+Tab to switch)', info.name, info.short.toLowerCase())}
          aria-label={tr('Approval: {0}', info.name)}
        >
          <span className="approval-emoji" aria-hidden>
            {info.emoji}
          </span>
          <span className="approval-name">{info.name}</span>
          <ChevronDown size={13} />
        </button>
      )}
    >
      {(close) => (
        <div className="approval-menu">
          <div className="menu-label">{tr('How much can Mitzi do on its own?')}</div>
          {LEVELS.map((l) => (
            <button key={l} onClick={() => (close(), onChange(l))} className={l === level ? 'on' : ''}>
              <span className="approval-emoji big" aria-hidden>
                {APPROVAL[l].emoji}
              </span>
              <span className="grow">
                {APPROVAL[l].name}
                <span className="menu-sub">{APPROVAL[l].description}</span>
              </span>
              {l === level && <Check size={14} className="menu-check" />}
            </button>
          ))}
          <div className="menu-foot muted small">
            <kbd>Shift</kbd>+<kbd>Tab</kbd> {tr('switches in the chat box')}
          </div>
        </div>
      )}
    </Menu>
  );
}
