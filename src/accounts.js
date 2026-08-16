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
  const exactNameMatches = accounts.filter((account) => account.name.toLowerCase() === lower);
  if (exactNameMatches.length === 1) return { account: exactNameMatches[0] };

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

// クォータはアカウント（メール）単位で共有されるため、レートリミットの発生時刻は
// 「その名前で記録されたもの」だけでなく「同じメールの別 config dir で記録されたもの」も見る。
//
// state.rateLimitedByEmail は後から入れた記録なので、それ以前に記録された state には
// 名前しか入っていない。同じメールの他アカウント名を引き当てて補う（移行処理を別途走らせない）。
export function rateLimitedAtFor(account, state = {}, accounts = null) {
  const email = account?.email ? account.email.toLowerCase() : null;
  const times = [Number(state.rateLimited?.[account?.name] || 0), Number(email ? state.rateLimitedByEmail?.[email] || 0 : 0)];
  if (email) {
    const siblings = accounts || listAccounts();
    for (const other of siblings) {
      if (!other.email || other.email.toLowerCase() !== email) continue;
      times.push(Number(state.rateLimited?.[other.name] || 0));
    }
  }
  return Math.max(...times);
}

// 無効化されたアカウントか (config.disabledAccounts に名前がある)。
// 自動選択 (レートリミット時の切替先 / 使用率フェイルオーバー / 既定の候補) から外すためのもので、
// 手動の `ccd use <name>` / `ccd run <name>` は従来どおり使える。
// 由来: 2026-08-17 「使わないはずの kimura が 5 ペインで動いていた」。既定が一度書き換わると
// その後もそのアカウントが選ばれ続けるため、明示的に候補から外せる必要があった。
export function isDisabled(account, config = {}) {
  const list = config.disabledAccounts;
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.some((name) => String(name) === account?.name || String(name) === account?.email);
}

export function isHealthy(account, state = {}, config = {}, accounts = null) {
  if (!account?.loggedIn) return false;
  if (isDisabled(account, config)) return false;
  const at = rateLimitedAtFor(account, state, accounts);
  if (!at) return true;
  const minutes = Number(config.autoSwitch?.cooldownMinutes || 0);
  return Date.now() - at >= minutes * 60 * 1000;
}

export function orderAccounts(accounts, order = []) {
  if (!Array.isArray(order) || order.length === 0) return accounts;
  const rank = new Map(order.map((name, i) => [String(name), i]));
  return [...accounts].sort((a, b) => (rank.get(a.name) ?? 9999) - (rank.get(b.name) ?? 9999));
}

export function chooseHealthyAccount(accounts, state = {}, config = {}, { excludeName = null } = {}) {
  return orderAccounts(accounts, config.autoSwitch?.order || [])
    .filter((account) => !excludeName || account.name !== excludeName)
    .find((account) => isHealthy(account, state, config)) || null;
}

export function resolveDefaultAccount(config = loadConfig()) {
  if (config.preferredAccount) {
    const resolved = resolveAccount(config.preferredAccount);
    if (resolved.account) return resolved.account;
  }
  return readAccount(defaultDir());
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
