// Plugins in the Claude Code format: a folder with .claude-plugin/plugin.json and any of
// skills/, commands/, agents/, .mcp.json and hooks/. Marketplaces are git repos with
// .claude-plugin/marketplace.json listing plugins. Mitzi maps agents to bots and MCP
// servers to connectors; hooks are listed but not run.
import { git } from '../git.js';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { Bot, MarketplaceInfo, McpServerConfig, McpTransport, PluginComponents, PluginInfo, PluginSource } from '../../shared/types.js';
import { newId, now, Store } from '../store.js';
import type { McpManager } from '../mcp/manager.js';
import type { CommandRoot } from './commands.js';
import { parseFrontmatter, str } from './frontmatter.js';
import type { SkillRoot } from './skills.js';

interface Manifest {
  name?: string;
  description?: string;
  version?: string;
  author?: string | { name?: string };
  homepage?: string;
  commands?: string | string[];
  agents?: string | string[];
  skills?: string | string[];
  mcpServers?: string | Record<string, unknown>;
  hooks?: unknown;
}

export interface AgentDef {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
}

export class MarketplaceRepoError extends Error {
  constructor(readonly url: string) {
    super('This repository is a plugin marketplace, not a single plugin');
  }
}

export function pluginSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'plugin';
}

const asList = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function readJson(path: string): any | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Expands ${CLAUDE_PLUGIN_ROOT} (and ${VAR} / ${VAR:-default} from the environment). */
export function expandVars(value: string, root: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_, name: string, fallback?: string) => {
    if (name === 'CLAUDE_PLUGIN_ROOT' || name === 'MITZI_PLUGIN_ROOT') return root;
    return process.env[name] ?? fallback ?? '';
  });
}

export function normalizeRepo(source: string): { url?: string; path?: string } {
  const s = source.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(s) && !existsSync(s)) return { url: `https://github.com/${s}.git` };
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(s)) return { url: s };
  const path = s.startsWith('~') ? join(homedir(), s.slice(1)) : resolve(s);
  return { path };
}

export class Plugins {
  readonly pluginsDir: string;
  readonly marketplacesDir: string;
  private readonly tmpDir: string;

  constructor(
    private readonly store: Store,
    home: string,
  ) {
    this.pluginsDir = join(home, 'plugins');
    this.marketplacesDir = join(home, 'marketplaces');
    this.tmpDir = join(home, 'tmp');
    for (const d of [this.pluginsDir, this.marketplacesDir, this.tmpDir]) mkdirSync(d, { recursive: true });
  }

  dir(id: string): string {
    return join(this.pluginsDir, id);
  }

  // ---------- Reading plugin folders ----------

  manifest(dir: string): Manifest | undefined {
    return readJson(join(dir, '.claude-plugin', 'plugin.json')) ?? readJson(join(dir, 'mitzi-plugin.json'));
  }

  private paths(dir: string, defaults: string, custom: string | string[] | undefined): string[] {
    const list = [join(dir, defaults), ...asList(custom).map((p) => resolve(dir, p))];
    return [...new Set(list)].filter((p) => p.startsWith(dir) && existsSync(p));
  }

  skillRoots(): SkillRoot[] {
    const roots: SkillRoot[] = [];
    for (const p of this.store.plugins.all().filter((x) => x.enabled)) {
      const dir = this.dir(p.id);
      if (p.skillPaths?.length) {
        roots.push({ dir, source: 'plugin', pluginId: p.id, only: p.skillPaths });
        continue;
      }
      for (const d of this.paths(dir, 'skills', this.manifest(dir)?.skills)) roots.push({ dir: d, source: 'plugin', pluginId: p.id });
    }
    return roots;
  }

  commandRoots(): CommandRoot[] {
    return this.store.plugins
      .all()
      .filter((p) => p.enabled)
      .flatMap((p) => this.paths(this.dir(p.id), 'commands', this.manifest(this.dir(p.id))?.commands).map((d) => ({ dir: d, source: p.name })));
  }

  agents(id: string): AgentDef[] {
    const dir = this.dir(id);
    const out: AgentDef[] = [];
    for (const d of this.paths(dir, 'agents', this.manifest(dir)?.agents)) {
      const files = statSync(d).isDirectory() ? readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => join(d, f)) : [d];
      for (const file of files) {
        try {
          const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'));
          const name = str(data.name).trim() || file.split(sep).pop()!.replace(/\.md$/, '');
          out.push({ name, description: str(data.description).trim(), systemPrompt: body.trim(), model: str(data.model).includes('/') ? str(data.model) : undefined });
        } catch {
          // Skip unreadable agents.
        }
      }
    }
    return out;
  }

  mcpServers(id: string): Record<string, any> {
    const dir = this.dir(id);
    const manifest = this.manifest(dir);
    const fromFile = (path: string) => {
      const json = readJson(path);
      return json?.mcpServers && typeof json.mcpServers === 'object' ? json.mcpServers : json && typeof json === 'object' ? json : {};
    };
    let servers: Record<string, any> = existsSync(join(dir, '.mcp.json')) ? fromFile(join(dir, '.mcp.json')) : {};
    if (typeof manifest?.mcpServers === 'string') servers = { ...servers, ...fromFile(resolve(dir, manifest.mcpServers)) };
    else if (manifest?.mcpServers && typeof manifest.mcpServers === 'object') servers = { ...servers, ...manifest.mcpServers };
    return Object.fromEntries(Object.entries(servers).filter(([, v]) => v && typeof v === 'object'));
  }

  components(id: string, skillPaths?: string[]): PluginComponents {
    const dir = this.dir(id);
    const manifest = this.manifest(dir);
    const count = (paths: string[], test: (p: string) => boolean) =>
      paths.reduce((n, p) => n + (statSync(p).isDirectory() ? readdirSync(p).filter((f) => test(join(p, f))).length : 1), 0);
    const skills = skillPaths?.length
      ? skillPaths.filter((p) => existsSync(join(dir, p, 'SKILL.md'))).length
      : count(this.paths(dir, 'skills', manifest?.skills), (p) => existsSync(join(p, 'SKILL.md')));
    return {
      skills,
      commands: count(this.paths(dir, 'commands', manifest?.commands), (p) => p.endsWith('.md')),
      agents: this.agents(id).length,
      mcpServers: Object.keys(this.mcpServers(id)).length,
      hooks: existsSync(join(dir, 'hooks', 'hooks.json')) || !!manifest?.hooks,
    };
  }

  // ---------- Installing ----------

  private tmp(): string {
    return join(this.tmpDir, newId());
  }

  private async clone(url: string, ref?: string): Promise<string> {
    const dest = this.tmp();
    const isSha = !!ref && /^[0-9a-f]{7,40}$/i.test(ref);
    await git(['clone', '--depth', '1', ...(ref && !isSha ? ['--branch', ref] : []), url, dest]);
    if (isSha) {
      await git(['fetch', '--depth', '1', 'origin', ref!], dest);
      await git(['checkout', '--quiet', 'FETCH_HEAD'], dest);
    }
    return dest;
  }

  private isMarketplace(dir: string): boolean {
    return existsSync(join(dir, '.claude-plugin', 'marketplace.json')) && !this.manifest(dir);
  }

  /** Copies a plugin folder into place and records it. Replaces an existing install of the same name. */
  private place(src: string, meta: { name?: string; description?: string; source: PluginSource; skillPaths?: string[] }): PluginInfo {
    const manifest = this.manifest(src);
    const name = manifest?.name || meta.name || src.split(sep).filter(Boolean).pop() || 'plugin';
    const id = pluginSlug(name);
    const dest = this.dir(id);
    const staging = `${dest}.new`;
    rmSync(staging, { recursive: true, force: true });
    cpSync(src, staging, { recursive: true, filter: (p) => !p.split(sep).includes('.git') });
    rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
    const existing = this.store.plugins.get(id);
    const author = typeof manifest?.author === 'string' ? manifest.author : manifest?.author?.name;
    const info: PluginInfo = {
      id,
      name,
      description: manifest?.description || meta.description || '',
      version: manifest?.version,
      author,
      homepage: manifest?.homepage,
      source: meta.source,
      enabled: existing?.enabled ?? true,
      skillPaths: meta.skillPaths,
      components: { skills: 0, commands: 0, agents: 0, mcpServers: 0, hooks: false },
      installedAt: existing?.installedAt ?? now(),
      updatedAt: now(),
    };
    info.components = this.components(id, meta.skillPaths);
    return this.store.plugins.put(info);
  }

  async installFromSource(source: string, ref?: string): Promise<PluginInfo> {
    const repo = normalizeRepo(source);
    if (repo.path) {
      if (!existsSync(repo.path) || !statSync(repo.path).isDirectory()) throw new Error(`Folder not found: ${repo.path}`);
      if (this.isMarketplace(repo.path)) throw new MarketplaceRepoError(repo.path);
      return this.place(repo.path, { source: { kind: 'local', path: repo.path } });
    }
    const tmp = await this.clone(repo.url!, ref);
    try {
      if (this.isMarketplace(tmp)) throw new MarketplaceRepoError(repo.url!);
      return this.place(tmp, { source: { kind: 'git', url: repo.url, ref } });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async installFromMarketplace(marketplaceId: string, pluginName: string): Promise<PluginInfo> {
    const mpDir = join(this.marketplacesDir, marketplaceId);
    const entry = this.marketplaceJson(marketplaceId)?.plugins?.find((p: any) => p?.name === pluginName);
    if (!entry) throw new Error(`No plugin named "${pluginName}" in this marketplace`);
    const meta = {
      name: entry.name,
      description: entry.description,
      source: { kind: 'marketplace' as const, marketplace: marketplaceId, path: pluginName },
      skillPaths: entry.strict === false && Array.isArray(entry.skills) ? entry.skills.map(String) : undefined,
    };
    const src = entry.source;
    if (typeof src === 'string') {
      const dir = resolve(mpDir, src);
      if (!(dir + sep).startsWith(mpDir + sep) || !existsSync(dir)) throw new Error(`Plugin folder not found in the marketplace: ${src}`);
      return this.place(dir, meta);
    }
    const url = src?.source === 'github' ? `https://github.com/${src.repo}.git` : src?.source === 'url' || src?.source === 'git-subdir' ? src.url : undefined;
    if (!url) throw new Error(`Unsupported plugin source "${src?.source ?? typeof src}"`);
    const tmp = await this.clone(url, src.sha ?? src.ref);
    try {
      const dir = src.source === 'git-subdir' ? resolve(tmp, src.path ?? '.') : tmp;
      if (!(dir + sep).startsWith(tmp + sep)) throw new Error('Invalid plugin path');
      return this.place(dir, meta);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async update(id: string): Promise<PluginInfo> {
    const p = this.store.plugins.get(id);
    if (!p) throw new Error('Plugin not found');
    if (p.source.kind === 'marketplace') {
      await this.refreshMarketplace(p.source.marketplace!).catch(() => {});
      return this.installFromMarketplace(p.source.marketplace!, p.source.path!);
    }
    return this.installFromSource(p.source.kind === 'local' ? p.source.path! : p.source.url!, p.source.ref);
  }

  uninstall(id: string): void {
    rmSync(this.dir(id), { recursive: true, force: true });
    this.store.plugins.delete(id);
  }

  // ---------- Marketplaces ----------

  marketplaceJson(id: string): any | undefined {
    const dir = join(this.marketplacesDir, id);
    return readJson(join(dir, '.claude-plugin', 'marketplace.json')) ?? readJson(join(dir, 'marketplace.json'));
  }

  async addMarketplace(source: string): Promise<MarketplaceInfo> {
    const repo = normalizeRepo(source);
    const src = repo.path ?? (await this.clone(repo.url!));
    try {
      const json = readJson(join(src, '.claude-plugin', 'marketplace.json')) ?? readJson(join(src, 'marketplace.json'));
      if (!json || !Array.isArray(json.plugins)) throw new Error('No .claude-plugin/marketplace.json found in that repository');
      const id = pluginSlug(json.name || source);
      const dest = join(this.marketplacesDir, id);
      rmSync(dest, { recursive: true, force: true });
      cpSync(src, dest, { recursive: true, filter: (p) => !p.split(sep).includes('.git') });
      return this.store.marketplaces.put({
        id,
        name: json.name || id,
        description: json.description ?? json.metadata?.description,
        source: source.trim(),
        plugins: [],
        updatedAt: now(),
      });
    } finally {
      if (!repo.path) rmSync(src, { recursive: true, force: true });
    }
  }

  async refreshMarketplace(id: string): Promise<MarketplaceInfo> {
    const mp = this.store.marketplaces.get(id);
    if (!mp) throw new Error('Marketplace not found');
    return this.addMarketplace(mp.source);
  }

  removeMarketplace(id: string): void {
    rmSync(join(this.marketplacesDir, id), { recursive: true, force: true });
    this.store.marketplaces.delete(id);
  }

  /** A marketplace with its plugin list and which of them are installed. */
  marketplaceView(mp: MarketplaceInfo): MarketplaceInfo {
    // A plugin's own name can differ from its marketplace entry, so match on either.
    const installed = new Set(
      this.store.plugins.all().flatMap((p) => [p.name, ...(p.source.kind === 'marketplace' && p.source.marketplace === mp.id && p.source.path ? [p.source.path] : [])]),
    );
    const plugins = (this.marketplaceJson(mp.id)?.plugins ?? []).filter((p: any) => p?.name).map((p: any) => ({
      name: String(p.name),
      description: p.description ? String(p.description) : undefined,
      category: p.category ? String(p.category) : undefined,
      version: p.version ? String(p.version) : undefined,
      author: typeof p.author === 'string' ? p.author : p.author?.name,
      homepage: p.homepage,
      installed: installed.has(p.name),
    }));
    return { ...mp, plugins };
  }

}

/** Makes bots (from agents) and connectors (from .mcp.json) match the enabled plugins. */
export async function syncPlugins(store: Store, plugins: Plugins, mcp: McpManager): Promise<void> {
  const enabled = store.plugins.all().filter((p) => p.enabled && existsSync(plugins.dir(p.id)));

  const wantedBots = new Set<string>();
  for (const p of enabled) {
    for (const agent of plugins.agents(p.id)) {
      const id = `p-${p.id}-${pluginSlug(agent.name)}`.slice(0, 120);
      wantedBots.add(id);
      const existing = store.bots.get(id);
      const bot: Bot = {
        id,
        name: agent.name,
        emoji: existing?.emoji ?? '🧩',
        description: agent.description || `From the ${p.name} plugin`,
        systemPrompt: agent.systemPrompt,
        model: existing?.model ?? agent.model,
        temperature: existing?.temperature,
        tools: existing?.tools ?? { artifacts: true, web: true, memory: true, skills: true, connectors: true },
        starters: existing?.starters ?? [],
        memory: existing?.memory ?? { mission: '', disposition: { skepticism: 3, literalism: 3, empathy: 3 }, autoRetain: true },
        pluginId: p.id,
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now(),
      };
      store.bots.put(bot);
    }
  }
  for (const b of store.bots.all()) if (b.pluginId && !wantedBots.has(b.id)) store.bots.delete(b.id);

  const wantedServers = new Set<string>();
  for (const p of enabled) {
    const root = plugins.dir(p.id);
    for (const [name, raw] of Object.entries(plugins.mcpServers(p.id))) {
      const id = `p-${p.id}-${pluginSlug(name)}`.slice(0, 120);
      wantedServers.add(id);
      const type = String(raw.type ?? (raw.url ? 'http' : 'stdio'));
      const transport: McpTransport = type === 'sse' ? 'sse' : type === 'stdio' ? 'stdio' : 'http';
      const env = Object.fromEntries(Object.entries(raw.env ?? {}).map(([k, v]) => [k, expandVars(String(v), root)]));
      const headers = Object.fromEntries(Object.entries(raw.headers ?? {}).map(([k, v]) => [k, expandVars(String(v), root)]));
      const existing = store.mcpServers.get(id);
      const next: McpServerConfig = {
        id,
        name,
        transport,
        command: raw.command ? expandVars(String(raw.command), root) : undefined,
        args: Array.isArray(raw.args) ? raw.args.map((a: unknown) => expandVars(String(a), root)) : undefined,
        env,
        url: raw.url ? expandVars(String(raw.url), root) : undefined,
        headers,
        enabled: existing?.enabled ?? true,
        trust: existing?.trust ?? 'ask',
        disabledTools: existing?.disabledTools ?? [],
        source: 'plugin',
        pluginId: p.id,
        oauth: existing?.oauth,
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now(),
      };
      const changed = !existing || ['transport', 'command', 'args', 'env', 'url', 'headers'].some((k) => JSON.stringify((existing as any)[k]) !== JSON.stringify((next as any)[k]));
      store.mcpServers.put(next);
      if (changed) {
        await mcp.disconnect(id);
        if (next.enabled) void mcp.ensure(id);
      }
    }
  }
  for (const s of store.mcpServers.all()) {
    if (s.source === 'plugin' && !wantedServers.has(s.id)) {
      await mcp.disconnect(s.id);
      store.mcpServers.delete(s.id);
    }
  }
}
