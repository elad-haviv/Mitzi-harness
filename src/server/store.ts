import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Artifact, Bot, Chat, LegacyMemory, Project, UiSettings } from '../shared/types.js';

export function newId(): string {
  return `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

export function now(): string {
  return new Date().toISOString();
}

function writeAtomic(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1));
  renameSync(tmp, path);
}

/** An in-memory collection mirrored to one JSON file per item. */
export class Collection<T extends { id: string }> {
  private readonly items = new Map<string, T>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const item = JSON.parse(readFileSync(join(dir, f), 'utf8')) as T;
        this.items.set(item.id, item);
      } catch {
        // Skip unreadable files rather than refusing to start.
      }
    }
  }

  all(): T[] {
    return [...this.items.values()];
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  put(item: T): T {
    if (!/^[\w-]+$/.test(item.id)) throw new Error(`Invalid id: ${item.id}`);
    this.items.set(item.id, item);
    writeAtomic(join(this.dir, `${item.id}.json`), item);
    return item;
  }

  delete(id: string): boolean {
    if (!this.items.delete(id)) return false;
    rmSync(join(this.dir, `${id}.json`), { force: true });
    return true;
  }
}

const DEFAULT_UI_SETTINGS: UiSettings = {
  memoryEnabled: true,
  memoryBackend: 'builtin',
  hindsightUrl: '',
  embeddingModel: '',
  recallTokens: 1200,
  autoCompactPercent: 80,
  keepRecentTurns: 2,
};

export class Store {
  readonly chats: Collection<Chat>;
  readonly projects: Collection<Project>;
  readonly bots: Collection<Bot>;
  readonly artifacts: Collection<Artifact>;
  /** Pre-memory-bank memories, kept only until they're migrated. */
  readonly legacyMemories: Collection<LegacyMemory>;
  private settingsPath: string;
  private uiSettings: UiSettings;

  constructor(readonly root: string) {
    this.chats = new Collection(join(root, 'chats'));
    this.projects = new Collection(join(root, 'projects'));
    this.bots = new Collection(join(root, 'bots'));
    this.artifacts = new Collection(join(root, 'artifacts'));
    this.legacyMemories = new Collection(join(root, 'memories'));
    this.settingsPath = join(root, 'settings.json');
    try {
      this.uiSettings = { ...DEFAULT_UI_SETTINGS, ...JSON.parse(readFileSync(this.settingsPath, 'utf8')) };
    } catch {
      this.uiSettings = { ...DEFAULT_UI_SETTINGS };
    }
  }

  get settings(): UiSettings {
    return this.uiSettings;
  }

  updateSettings(patch: Partial<UiSettings>): UiSettings {
    this.uiSettings = { ...this.uiSettings, ...patch };
    writeAtomic(this.settingsPath, this.uiSettings);
    return this.uiSettings;
  }
}
