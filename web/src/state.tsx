import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { speaker } from './speech';
import { api, ApiError, Bot, ChatListItem, ModelInfo, ProjectView, PublicSettings, TaskView, UpdateStatus } from './api';

export type Theme = 'system' | 'light' | 'dark';

/** Mitzi's logo, also the default bot's icon. */
export const LOGO = '🐱';

interface Toast {
  id: number;
  message: string;
  tone: 'error' | 'info';
}

interface AppState {
  settings?: PublicSettings;
  chats: ChatListItem[];
  projects: ProjectView[];
  bots: Bot[];
  models: ModelInfo[];
  modelsError?: string;
  authError: boolean;
  theme: Theme;
  setTheme(t: Theme): void;
  refreshSettings(): Promise<void>;
  refreshChats(): Promise<void>;
  refreshProjects(): Promise<void>;
  refreshBots(): Promise<void>;
  refreshModels(): Promise<void>;
  /** Scheduled tasks, polled so finished runs show up in the sidebar. */
  tasks: TaskView[];
  refreshTasks(): Promise<void>;
  /** The last update check (the server checks in the background). */
  update?: UpdateStatus;
  setUpdate(u: UpdateStatus): void;
  toast(message: string, tone?: Toast['tone']): void;
  toasts: Toast[];
  dismissToast(id: number): void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp outside provider');
  return ctx;
}

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('mitzi.theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

let toastSeq = 0;

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<PublicSettings>();
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [update, setUpdate] = useState<UpdateStatus>();
  const [modelsError, setModelsError] = useState<string>();
  const [authError, setAuthError] = useState(false);
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, tone: Toast['tone'] = 'error') => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  // Say once (per error) why read-aloud fell back to the browser's voice.
  useEffect(() => {
    let last = '';
    speaker.onServerError = (message) => {
      if (message === last) return;
      last = message;
      toast(`The speech model failed, so your browser’s voice was used. ${message}`);
    };
    return () => void (speaker.onServerError = undefined);
  }, [toast]);

  const guard = useCallback(
    async <T,>(p: Promise<T>, set: (v: T) => void) => {
      try {
        set(await p);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) setAuthError(true);
        else toast((err as Error).message);
      }
    },
    [toast],
  );

  const refreshSettings = useCallback(() => guard(api.settings(), setSettings), [guard]);
  const refreshChats = useCallback(() => guard(api.chats(), setChats), [guard]);
  const refreshProjects = useCallback(() => guard(api.projects(), setProjects), [guard]);
  const refreshBots = useCallback(() => guard(api.bots(), setBots), [guard]);
  const refreshTasks = useCallback(async () => {
    try {
      const next = await api.tasks();
      setTasks((prev) => {
        // A run finishing means a new chat to list.
        const finished = (list: TaskView[]) => list.flatMap((t) => t.runs.filter((r) => r.status !== 'running').map((r) => r.id)).join();
        if (finished(prev) !== finished(next)) void api.chats().then(setChats).catch(() => {});
        return next;
      });
    } catch {
      // Polling; errors surface elsewhere.
    }
  }, []);
  const refreshModels = useCallback(async () => {
    try {
      setModels(await api.models());
      setModelsError(undefined);
    } catch (err) {
      setModelsError((err as Error).message);
    }
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      if (t === 'system') localStorage.removeItem('mitzi.theme');
      else localStorage.setItem('mitzi.theme', t);
    } catch {
      // Not persisted; fine.
    }
  }, []);

  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    void refreshSettings();
    void refreshChats();
    void refreshProjects();
    void refreshBots();
    void refreshModels();
    void refreshTasks();
    const timer = setInterval(() => document.visibilityState === 'visible' && void refreshTasks(), 30_000);
    // The server's last update check; cheap, it doesn't contact GitHub itself.
    const loadUpdate = () => api.updateInfo().then(setUpdate, () => {});
    const first = setTimeout(loadUpdate, 20_000);
    const updates = setInterval(loadUpdate, 3 * 3600_000);
    return () => {
      clearInterval(timer);
      clearTimeout(first);
      clearInterval(updates);
    };
  }, [refreshSettings, refreshChats, refreshProjects, refreshBots, refreshModels, refreshTasks]);

  const value = useMemo<AppState>(
    () => ({
      settings,
      chats,
      projects,
      bots,
      models,
      modelsError,
      authError,
      theme,
      setTheme,
      refreshSettings,
      refreshChats,
      refreshProjects,
      refreshBots,
      refreshModels,
      tasks,
      refreshTasks,
      update,
      setUpdate,
      toast,
      toasts,
      dismissToast,
    }),
    [settings, chats, projects, bots, models, modelsError, authError, theme, setTheme, refreshSettings, refreshChats, refreshProjects, refreshBots, refreshModels, tasks, refreshTasks, update, toast, toasts, dismissToast],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Formats a model id like "anthropic/claude-sonnet-4.5" as "Claude Sonnet 4.5". */
export function modelLabel(id: string, models: ModelInfo[]): string {
  const found = models.find((m) => m.id === id);
  if (found) return found.name.replace(/^[^:]+:\s*/, '');
  const base = id.split(/[/:]/).pop() ?? id;
  return base.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
