import fs from 'node:fs';
import path from 'node:path';
import { currentDir, defaultDir, listAccounts, normalizeDir } from '../accounts.js';
import { loadConfig } from '../config.js';
import { commandExists, readJson } from '../util.js';

function hasHook(account) {
  const settings = readJson(path.join(account.dir, 'settings.json')) || {};
  const entries = settings.hooks?.StopFailure || [];
  return Array.isArray(entries) && entries.some((entry) => entry.matcher === 'rate_limit' && (entry.hooks || []).some((hook) => hook.command === 'ccd hook rate-limit'));
}

export function run() {
  const config = loadConfig();
  const accounts = listAccounts();
  const checks = [];
  const bin = config.claudeBin || 'claude';
  checks.push(['claude binary', commandExists(bin), bin]);
  for (const account of accounts) checks.push([`login ${account.name}`, account.loggedIn, account.email || 'not logged in']);
  checks.push(['shell integration', process.env.CCD_SHELL_INTEGRATION === '1', 'CCD_SHELL_INTEGRATION']);
  checks.push(['StopFailure hook', accounts.some(hasHook), 'settings.json']);
  const switchable = accounts.filter((account) => account.loggedIn && account.dir !== currentDir()).length;
  checks.push(['auto switch candidates', config.autoSwitch.mode === 'off' || switchable > 0, `${config.autoSwitch.mode}, ${switchable} candidate(s)`]);
  const explicitDefault = process.env.CLAUDE_CONFIG_DIR && normalizeDir(process.env.CLAUDE_CONFIG_DIR) === normalizeDir(defaultDir());
  checks.push(['default env trap', !explicitDefault, 'CLAUDE_CONFIG_DIR must be unset for default account']);

  let ok = true;
  for (const [name, pass, detail] of checks) {
    if (!pass) ok = false;
    process.stdout.write(`${pass ? 'OK' : 'NG'} ${name}: ${detail}\n`);
  }
  if (accounts.length === 0 && fs.existsSync(defaultDir())) process.stdout.write('OK account scan: default directory exists\n');
  return ok ? 0 : 1;
}
