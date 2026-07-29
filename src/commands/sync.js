import fs from 'node:fs';
import path from 'node:path';
import { defaultDir, resolveAccount } from '../accounts.js';
import { readJson, shortenHome, writeJsonAtomic } from '../util.js';

const syncItems = ['skills', 'rules', 'agents', 'commands', 'CLAUDE.md'];

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

export function run(args = []) {
  const noMcp = args.includes('--no-mcp');
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
  if (!noMcp) lines.push(mergeMcp(path.join(path.dirname(from), '.claude.json'), account.configFile, dryRun));
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
