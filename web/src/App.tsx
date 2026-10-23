import { KeyRound, PanelLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Toasts } from './components/ui';
import { BotsPage } from './pages/Bots';
import { ChatView } from './pages/ChatView';
import { SettingsPage } from './pages/Library';
import { MemoryPage } from './pages/Memory';
import { ConnectorsPage } from './pages/Connectors';
import { PluginsPage } from './pages/Plugins';
import { SkillsPage } from './pages/Skills';
import { ArtifactPage, ArtifactsPage } from './pages/Workspace';
import { TasksPage } from './pages/Tasks';
import { ProjectPage, ProjectsPage } from './pages/Projects';
import { useRoute } from './router';
import { useApp } from './state';

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
  const narrow = () => window.matchMedia('(max-width: 860px)').matches;
  const [collapsed, setCollapsed] = useState(() => narrow() || readCollapsed());

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

  if (authError) {
    return (
      <div className="center-screen">
        <div className="empty" style={{ maxWidth: 460, borderStyle: 'solid', background: 'var(--surface)' }}>
          <div className="empty-icon">
            <KeyRound size={22} />
          </div>
          <h3>Open Mitzi from your terminal</h3>
          <p>
            For your security, Mitzi only accepts requests that carry the access token from the link printed by <code>mitzi ui</code>. Open that link
            to continue.
          </p>
        </div>
      </div>
    );
  }

  let page;
  switch (route.page) {
    case 'chat':
      page = <ChatView key="chat" routeId={route.id} />;
      break;
    case 'new':
      page = <ChatView key="chat" projectId={route.projectId} botId={route.botId} />;
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
      page = <SettingsPage />;
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
  }

  return (
    <div className="app">
      <Sidebar route={route} collapsed={collapsed} onCollapse={toggle} />
      {!collapsed && narrow() && <div className="sidebar-scrim" onClick={toggle} />}
      <main className="main">
        {collapsed && (
          <button className="icon-btn" style={{ position: 'absolute', top: 12, left: 10, zIndex: 20 }} onClick={toggle} aria-label="Open sidebar" title="Open sidebar">
            <PanelLeft size={18} />
          </button>
        )}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', paddingLeft: collapsed && !narrow() ? 36 : 0 }}>{page}</div>
      </main>
      <Toasts />
    </div>
  );
}
