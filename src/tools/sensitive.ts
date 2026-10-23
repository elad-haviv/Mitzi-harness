// What counts as risky in the "House cat" approval mode: Mitzi works on its own, but asks first before these.
import { homedir } from 'node:os';
import { relative, sep } from 'node:path';
import { resolvePath, type ToolContext } from './types.js';

const RISKY_COMMANDS: [RegExp, string][] = [
  [/\b(rm|rmdir|unlink|shred|del|rd|Remove-Item)\b/i, 'deletes files'],
  [/\bsudo\b|\bsu\s|\bdoas\b|\brunas\b/i, 'runs as administrator'],
  [/\b(chmod|chown|chgrp|icacls|takeown)\b/i, 'changes file permissions'],
  [/\b(dd|mkfs\w*|fdisk|parted|diskpart|format)\b\s/i, 'touches disks'],
  [/\b(shutdown|reboot|halt|poweroff|launchctl|systemctl|service)\b/i, 'changes the system'],
  [/\b(kill|killall|pkill|taskkill)\b/i, 'stops processes'],
  [/\bgit\s+(push|reset\s+--hard|clean|rebase|filter-branch|branch\s+-D|checkout\s+--|restore|stash\s+(drop|clear))\b/i, 'changes git history or a remote'],
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|publish|unpublish|update|upgrade)\b|\bnpx\b/i, 'installs or publishes packages'],
  [/\b(pip3?|pipx|uv|poetry|conda|gem|cargo|go)\s+(install|uninstall|add|remove|publish)\b/i, 'installs or publishes packages'],
  [/\b(apt|apt-get|yum|dnf|pacman|brew|winget|choco|snap)\b/i, 'installs software'],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(ba|z)?sh\b/i, 'runs a script from the internet'],
  [/\b(docker|podman|kubectl|terraform|helm)\s+(rm|rmi|delete|destroy|apply|prune|system\s+prune|down)\b/i, 'changes infrastructure'],
  [/\b(drop\s+(table|database)|truncate\s+table|delete\s+from)\b/i, 'deletes data'],
  [/\bcrontab\b|\bsetx?\b\s+\w+=|>\s*~?\/?\.(bashrc|zshrc|profile)/i, 'changes the environment'],
  [/(^|[^<>])>\s*\/(etc|usr|bin|sbin|var|boot|System)\b/i, 'writes system files'],
  [/\bmv\b[^|;&]*\s(\/|~)/, 'moves files out of the project'],
];

/** Why a shell command is risky, or undefined. */
export function riskyCommand(command: string): string | undefined {
  for (const [re, why] of RISKY_COMMANDS) if (re.test(command)) return why;
  return undefined;
}

// Places a bot shouldn't write to without asking, even inside the working folder.
const PROTECTED = /(^|[\\/])(\.ssh|\.gnupg|\.aws|\.config|\.git|\.env[^\\/]*|\.bashrc|\.zshrc|\.profile|\.npmrc|id_[a-z0-9]+)($|[\\/])/i;

/** Why writing to a path is risky: outside the working folder, or a protected file. */
export function riskyPath(ctx: ToolContext, path: string): string | undefined {
  let abs: string;
  try {
    abs = resolvePath(ctx, path);
  } catch {
    return undefined;
  }
  const rel = relative(ctx.cwd, abs);
  if (rel.startsWith('..') || rel === abs || (ctx.cwd === homedir() && rel.split(sep).length < 2)) return 'writes outside the project folder';
  if (PROTECTED.test(rel)) return 'writes a protected file';
  return undefined;
}
