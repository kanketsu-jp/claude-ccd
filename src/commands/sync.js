import fs from 'node:fs';
import path from 'node:path';
import { defaultDir, resolveAccount } from '../accounts.js';
import { readJson, shortenHome, writeJsonAtomic } from '../util.js';

const syncItems = ['skills', 'rules', 'agents', 'commands', 'CLAUDE.md', 'statusline-command.sh'];

function linkItem(source, target, dryRun) {
  if (!fs.existsSync(source)) return `skip missing ${shortenHome(source)}`;
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return `skip existing symlink ${shortenHome(target)}`;
    return `skip existing real path ${shortenHome(target)}`;
  }
  if (!dryRun) fs.symlinkSync(source, target, fs.statSync(source).isDirectory() ? 'dir' : 'file');
  return `link ${shortenHome(target)} -> ${shortenHome(source)}`;
}

function mergeMcp(defaultConfigFile, targetConfigFile, dryRun) {
  const source = readJson(defaultConfigFile) || {};
  if (!source.mcpServers) return 'skip mcpServers missing in default config';
  const target = readJson(targetConfigFile) || {};
  const next = { ...target, mcpServers: { ...(target.mcpServers || {}), ...source.mcpServers } };
  if (!dryRun) {
    if (fs.existsSync(targetConfigFile)) fs.copyFileSync(targetConfigFile, `${targetConfigFile}.bak`);
    writeJsonAtomic(targetConfigFile, next);
  }
  return `merge mcpServers into ${shortenHome(targetConfigFile)}`;
}

function backupName(file) {
  const iso = new Date(fs.statSync(file).mtimeMs).toISOString().replaceAll(':', '-');
  return `${file}.bak-${iso}`;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function copyFile(source, target, dryRun, lines) {
  lines.push(`copy ${shortenHome(source)} -> ${shortenHome(target)}`);
  if (dryRun) return;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, target);
  fs.utimesSync(target, fs.statSync(source).atime, fs.statSync(source).mtime);
}

function mergeProjectDirectory(sourceRoot, targetRoot, dryRun, lines, rel = '') {
  const current = path.join(targetRoot, rel);
  let entries = [];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const target = path.join(current, entry.name);
    const relative = path.join(rel, entry.name);
    const source = path.join(sourceRoot, relative);
    if (entry.isDirectory()) {
      if (!dryRun && !fs.existsSync(source)) fs.mkdirSync(source, { recursive: true, mode: 0o700 });
      mergeProjectDirectory(sourceRoot, targetRoot, dryRun, lines, relative);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!fs.existsSync(source)) {
      copyFile(target, source, dryRun, lines);
      continue;
    }
    if (!entry.name.endsWith('.jsonl') || !fs.statSync(source).isFile()) continue;
    const sourceMtime = fs.statSync(source).mtimeMs;
    const targetMtime = fs.statSync(target).mtimeMs;
    if (targetMtime > sourceMtime) {
      const sourceBackup = backupName(source);
      lines.push(`backup older ${shortenHome(source)} -> ${shortenHome(sourceBackup)}`);
      if (!dryRun) fs.copyFileSync(source, sourceBackup);
      copyFile(target, source, dryRun, lines);
    } else if (sourceMtime > targetMtime) {
      const targetBackup = backupName(target);
      lines.push(`backup older ${shortenHome(target)} -> ${shortenHome(targetBackup)}`);
      if (!dryRun) fs.copyFileSync(target, targetBackup);
    }
  }
}

function linkProjects(source, target, dryRun) {
  const lines = [];
  if (!fs.existsSync(source)) return [`skip missing ${shortenHome(source)}`];
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return [`skip existing symlink ${shortenHome(target)}`];
    if (!stat.isDirectory()) return [`skip existing real path ${shortenHome(target)}`];
    mergeProjectDirectory(source, target, dryRun, lines);
    const backup = path.join(path.dirname(target), `projects.bak-${timestamp()}`);
    lines.push(`backup ${shortenHome(target)} -> ${shortenHome(backup)}`);
    lines.push(`link ${shortenHome(target)} -> ${shortenHome(source)}`);
    if (!dryRun) {
      fs.renameSync(target, backup);
      fs.symlinkSync(source, target, 'dir');
    }
    return lines;
  }
  if (!dryRun) fs.symlinkSync(source, target, 'dir');
  return [`link ${shortenHome(target)} -> ${shortenHome(source)}`];
}

function mergeStatusLine(defaultSettingsFile, targetSettingsFile, dryRun) {
  const source = readJson(defaultSettingsFile) || {};
  if (!Object.prototype.hasOwnProperty.call(source, 'statusLine')) return 'skip statusLine missing in default settings';
  const target = readJson(targetSettingsFile) || {};
  const next = { ...target, statusLine: source.statusLine };
  if (!dryRun) {
    if (fs.existsSync(targetSettingsFile)) fs.copyFileSync(targetSettingsFile, `${targetSettingsFile}.bak`);
    writeJsonAtomic(targetSettingsFile, next);
  }
  return `merge statusLine into ${shortenHome(targetSettingsFile)}`;
}

export function run(args = []) {
  const noMcp = args.includes('--no-mcp');
  const noProjects = args.includes('--no-projects');
  const noSettings = args.includes('--no-settings');
  const dryRun = args.includes('--dry-run');
  const query = args.find((arg) => !arg.startsWith('--'));
  if (!query) {
    process.stderr.write('Usage: ccd sync <account> [--no-mcp] [--dry-run]\n');
    return 1;
  }
  const resolved = resolveAccount(query);
  if (resolved.error) {
    process.stderr.write(`Account ${resolved.error}\n`);
    return 1;
  }
  const account = resolved.account;
  if (account.isDefault) {
    process.stderr.write('Cannot sync the default account into itself.\n');
    return 1;
  }
  if (!dryRun) fs.mkdirSync(account.dir, { recursive: true, mode: 0o700 });
  const from = defaultDir();
  const lines = [];
  for (const item of syncItems) lines.push(linkItem(path.join(from, item), path.join(account.dir, item), dryRun));
  if (!noProjects) lines.push(...linkProjects(path.join(from, 'projects'), path.join(account.dir, 'projects'), dryRun));
  if (!noMcp) lines.push(mergeMcp(path.join(path.dirname(from), '.claude.json'), account.configFile, dryRun));
  if (!noSettings) lines.push(mergeStatusLine(path.join(from, 'settings.json'), path.join(account.dir, 'settings.json'), dryRun));
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
