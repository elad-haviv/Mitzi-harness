import { useEffect, useState } from 'react';

export type Route =
  | { page: 'new'; projectId?: string; botId?: string }
  | { page: 'chat'; id: string }
  | { page: 'projects' }
  | { page: 'project'; id: string }
  | { page: 'bots' }
  | { page: 'artifacts' }
  | { page: 'artifact'; id: string }
  | { page: 'memory'; botId?: string }
  | { page: 'connectors' }
  | { page: 'skills' }
  | { page: 'plugins' }
  | { page: 'tasks' }
  | { page: 'settings'; section?: string };

export function parseRoute(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  switch (parts[0]) {
    case 'chat':
      if (parts[1]) return { page: 'chat', id: parts[1] };
      break;
    case 'projects':
      return parts[1] ? { page: 'project', id: parts[1] } : { page: 'projects' };
    case 'bots':
      return { page: 'bots' };
    // Documents became artifacts; keep old links working.
    case 'docs':
    case 'artifacts':
      return parts[1] ? { page: 'artifact', id: parts[1] } : { page: 'artifacts' };
    case 'memory':
      return { page: 'memory', botId: parts[1] };
    case 'settings':
      return { page: 'settings', section: parts[1] };
    case 'tasks':
      return { page: 'tasks' };
    case 'connectors':
    case 'skills':
    case 'plugins':
      return { page: parts[0] };
  }
  return { page: 'new', projectId: params.get('project') ?? undefined, botId: params.get('bot') ?? undefined };
}

export function href(route: Route): string {
  switch (route.page) {
    case 'new': {
      const q = new URLSearchParams();
      if (route.projectId) q.set('project', route.projectId);
      if (route.botId) q.set('bot', route.botId);
      const qs = q.toString();
      return `#/new${qs ? `?${qs}` : ''}`;
    }
    case 'chat':
      return `#/chat/${route.id}`;
    case 'project':
      return `#/projects/${route.id}`;
    case 'artifact':
      return `#/artifacts/${route.id}`;
    case 'settings':
      return `#/settings${route.section ? `/${route.section}` : ''}`;
    case 'memory':
      return `#/memory${route.botId ? `/${route.botId}` : ''}`;
    default:
      return `#/${route.page}`;
  }
}

export function navigate(route: Route, replace = false): void {
  const target = href(route);
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
