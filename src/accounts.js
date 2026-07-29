import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { isLoggedIn, keychainServiceName } from './credentials.js';
import { expandTilde, readJson, stripTrailingSlash } from './util.js';

export function defaultDir() {
  return path.join(os.homedir(), '.claude');
}

export function normalizeDir(dir) {
  return stripTrailingSlash(path.resolve(expandTilde(dir)));
}

export function dirForName(name = '') {
  const q = String(name || '').trim();
  if (q === '' || q === 'default' || q === 'main' || q === '1') return defaultDir();
  if (path.isAbsolute(q) || q.startsWith('~/')) return normalizeDir(q);
  if (/^[2-9]$/.test(q)) return path.join(os.homedir(), `.claude-account${q}`);
  return path.join(os.homedir(), `.claude-${q}`);
}

export function nameForDir(dir) {
  const normalized = normalizeDir(dir);
  const home = normalizeDir(os.homedir());
  if (normalized === normalizeDir(defaultDir())) return 'default';
  const prefix = path.join(home, '.claude-');
  if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  return path.basename(normalized);
}

export function configFileForDir(dir) {
  const normalized = normalizeDir(dir);
  const legacy = path.join(normalized, '.config.json');
  if (fs.existsSync(legacy)) return legacy;
  if (normalized === normalizeDir(defaultDir())) return path.join(os.homedir(), '.claude.json');
  return path.join(normalized, '.claude.json');
}

export function readAccount(dir) {
  const normalized = normalizeDir(dir);
  const isDefault = normalized === normalizeDir(defaultDir());
  const configFile = configFileForDir(normalized);
  const data = readJson(configFile) || {};
  const oauth = data.oauthAccount || {};
  const account = {
    name: nameForDir(normalized),
    dir: normalized,
    isDefault,
    configFile,
    email: oauth.emailAddress || null,
    plan: oauth.organizationType || null,
    tier: oauth.organizationRateLimitTier || null,
    displayName: oauth.displayName || null,
    organizationName: oauth.organizationName || null,
    loggedIn: false,
    keychainService: keychainServiceName(normalized, { isDefault }),
    keychainConfigDir: normalized,
  };
  account.loggedIn = isLoggedIn(account);
  return account;
}

export function listAccounts() {
  const dirs = [];
  const add = (dir) => {
    const normalized = normalizeDir(dir);
    if (!dirs.includes(normalized)) dirs.push(normalized);
  };

  if (fs.existsSync(defaultDir())) add(defaultDir());
  try {
    for (const entry of fs.readdirSync(os.homedir(), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('.claude-')) add(path.join(os.homedir(), entry.name));
    }
  } catch {
    // ホームを走査できない場合は追加ディレクトリだけを見る。
  }

  for (const extra of loadConfig().extraDirs || []) add(extra);

  return dirs
    .filter((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
    .map(readAccount);
}

export function currentDir() {
  return normalizeDir(process.env.CLAUDE_CONFIG_DIR || defaultDir());
}

export function resolveAccount(query) {
  const q = String(query || '').trim();
  if (q === '' || q === 'default' || q === 'main' || q === '1') return { account: readAccount(defaultDir()) };
  const accounts = listAccounts();
  if (path.isAbsolute(q) || q.startsWith('~/')) {
    const dir = normalizeDir(q);
    const matches = accounts.filter((account) => account.dir === dir);
    if (matches.length === 1) return { account: matches[0] };
    if (fs.existsSync(dir)) return { account: readAccount(dir) };
    return { error: 'not-found' };
  }

  const lower = q.toLowerCase();
  const matches = accounts.filter((account) => {
    if (account.name.toLowerCase() === lower) return true;
    return account.email ? account.email.toLowerCase().includes(lower) : false;
  });
  if (matches.length === 1) return { account: matches[0] };
  if (matches.length > 1) return { error: 'ambiguous', matches };

  const guessed = dirForName(q);
  if (fs.existsSync(guessed)) return { account: readAccount(guessed) };
  return { error: 'not-found' };
}

export function envForAccount(account) {
  const env = { ...process.env };
  if (account.isDefault) {
    delete env.CLAUDE_CONFIG_DIR;
  } else {
    env.CLAUDE_CONFIG_DIR = account.dir;
  }
  return env;
}
