import { SearchDialog } from './components/SearchDialog';
import { InsightsPage } from './pages/Insights';
import { ArchivePage } from './pages/Archive';
import { WorkflowEditor, WorkflowsPage } from './pages/Workflows';
import { KeyRound, PanelLeft, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Toasts } from './components/ui';
import { BotsPage } from './pages/Bots';
import { ChatView } from './pages/ChatView';
import { SettingsPage } from './pages/Settings';
import { MemoryPage } from './pages/Memory';
import { ConnectorsPage } from './pages/Connectors';
import { PluginsPage } from './pages/Plugins';
import { SkillsPage } from './pages/Skills';
import { ArtifactPage, ArtifactsPage } from './pages/Workspace';
import { TasksPage } from './pages/Tasks';
import { ProjectPage, ProjectsPage } from './pages/Projects';
import { navigate, Route, useRoute } from './router';
import { useApp } from './state';
import { tr } from './i18n';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem('mitzi.sidebar') === 'collapsed';
  } catch {
    return false;
  }
}

export function App() {
  const route = useRoute();
  const { authError } = useApp();
  // The settings page gets an X that returns to where you were; remember the last non-settings page.
  const lastPage = useRef<Route>({ page: 'new' });
  if (route.page !== 'settings') lastPage.current = route;
  const narrow = () => window.matchMedia('(max-width: 860px)').matches;
  const [collapsed, setCollapsed] = useState(() => narrow() || readCollapsed());
  // Search everything: Ctrl/⌘+K, or from the sidebar.
  const [searching, setSearching] = useState<string>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearching((s) => (s === undefined ? '' : undefined));
      }
    };
    const onOpen = (e: Event) => setSearching((e as CustomEvent<string>).detail ?? '');
    window.addEventListener('keydown', onKey);
    window.addEventListener('mitzi:search', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mitzi:search', onOpen);
    };
  }, []);

  // On small screens the sidebar is an overlay: close it after navigating.
  useEffect(() => {
    if (narrow()) setCollapsed(true);
  }, [route]);

  const toggle = () => {
    setCollapsed((c) => {
      try {
        if (!narrow()) localStorage.setItem('mitzi.sidebar', c ? 'open' : 'collapsed');
      } catch {
        // Not persisted.
      }
      return !c;
    });
  };

  const closeSettings = () => {
    const back = lastPage.current;
    navigate(back, back.page === 'new');
  };

  if (authError) {
    return (
      <div className="center-screen">
        <div className="empty" style={{ maxWidth: 460, borderStyle: 'solid', background: 'var(--surface)' }}>
          <div className="empty-icon">
            <KeyRound size={22} />
          </div>
          <h3>{tr('Open Mitzi from your terminal')}</h3>
          <p>
            {tr('For your security, Mitzi only accepts requests that carry the access token from the link printed by')}{' '}<code>mitzi ui</code>{tr('. Open that link to continue.')}
          </p>
        </div>
      </div>
    );
  }

  let page;
  switch (route.page) {
    case 'chat':
      page = <ChatView key="chat" routeId={route.id} focusMessage={route.message} />;
      break;
    case 'new':
      page = <ChatView key="chat" projectId={route.projectId} botId={route.botId} model={route.model} />;
      break;
    case 'projects':
      page = <ProjectsPage />;
      break;
    case 'project':
      page = <ProjectPage id={route.id} />;
      break;
    case 'bots':
      page = <BotsPage />;
      break;
    case 'artifacts':
      page = <ArtifactsPage />;
      break;
    case 'artifact':
      page = <ArtifactPage key={route.id} id={route.id} />;
      break;
    case 'memory':
      page = <MemoryPage botId={route.botId} />;
      break;
    case 'settings':
      page = <SettingsPage section={route.section} onClose={closeSettings} />;
      break;
    case 'connectors':
      page = <ConnectorsPage />;
      break;
    case 'skills':
      page = <SkillsPage />;
      break;
    case 'plugins':
      page = <PluginsPage />;
      break;
    case 'tasks':
      page = <TasksPage />;
      break;
    case 'workflows':
      page = <WorkflowsPage />;
      break;
    case 'workflow':
      page = <WorkflowEditor key={route.id} id={route.id} />;
      break;
    case 'insights':
      page = <InsightsPage tab={route.tab} />;
      break;
    case 'archived':
      page = <ArchivePage />;
      break;
  }

  return (
    <div className="app">
      {searching !== undefined && <SearchDialog initial={searching} onClose={() => setSearching(undefined)} />}
      <Sidebar route={route} collapsed={collapsed} onCollapse={toggle} />
      {!collapsed && narrow() && <div className="sidebar-scrim" onClick={toggle} />}
      <main className="main">
        {collapsed && (
          <button className="icon-btn" style={{ position: 'absolute', top: 12, left: 10, zIndex: 20 }} onClick={toggle} aria-label={tr('Open sidebar')} title={tr('Open sidebar')}>
            <PanelLeft size={18} />
          </button>
        )}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', paddingLeft: collapsed && !narrow() ? 36 : 0 }}>
          {page}
        </div>
      </main>
      <Toasts />
    </div>
  );
}
