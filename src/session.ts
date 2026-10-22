import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MITZI_HOME } from './config.js';
import type { Message } from './openrouter.js';

export interface SessionData {
  id: string;
  cwd: string;
  model: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

const sessionsDir = () => join(MITZI_HOME, 'sessions');

export function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function saveSession(data: SessionData): void {
  mkdirSync(sessionsDir(), { recursive: true });
  writeFileSync(join(sessionsDir(), `${data.id}.json`), JSON.stringify(data, null, 2));
}

export function loadSession(id: string): SessionData {
  return JSON.parse(readFileSync(join(sessionsDir(), `${id.replace(/\.json$/, '')}.json`), 'utf8'));
}

/** Sessions for a directory, most recent first. */
export function listSessions(cwd?: string): SessionData[] {
  let files: string[];
  try {
    files = readdirSync(sessionsDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const sessions: SessionData[] = [];
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(sessionsDir(), f), 'utf8')) as SessionData;
      if (!cwd || s.cwd === cwd) sessions.push(s);
    } catch {
      // Corrupt session file; ignore.
    }
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
