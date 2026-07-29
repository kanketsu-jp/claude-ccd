import fs from 'node:fs';
import path from 'node:path';
import { run, sha256Hex8 } from './util.js';

export function keychainServiceName(configDir, { isDefault } = {}) {
  if (isDefault) return 'Claude Code-credentials';
  return `Claude Code-credentials-${sha256Hex8(String(configDir).normalize('NFC'))}`;
}

export function isLoggedIn(account) {
  try {
    if (process.env.CCD_SKIP_KEYCHAIN_CHECK === '1') return false;
    if (process.platform === 'darwin') {
      const service = account.keychainService || keychainServiceName(account.keychainConfigDir || account.dir, account);
      return run('security', ['find-generic-password', '-s', service], { stdio: ['ignore', 'pipe', 'pipe'] }).status === 0;
    }
    return fs.existsSync(path.join(account.dir, '.credentials.json'));
  } catch {
    return false;
  }
}
