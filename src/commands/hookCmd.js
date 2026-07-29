import fs from 'node:fs';
import path from 'node:path';
import { defaultDir, resolveAccount } from '../accounts.js';
import { loadConfig, saveConfig } from '../config.js';
import { runRateLimitHook } from '../hook.js';
import { readJson, writeJsonAtomic } from '../util.js';

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function parseAccount(args) {
  const index = args.indexOf('--account');
  if (index < 0) return { dir: defaultDir(), name: 'default', isDefault: true };
  const resolved = resolveAccount(args[index + 1]);
  return resolved.account || null;
}

function settingsPath(account) {
  return path.join(account.dir, 'settings.json');
}

function ensureHook(settings) {
  settings.hooks ||= {};
  const entries = Array.isArray(settings.hooks.StopFailure) ? settings.hooks.StopFailure : [];
  let entry = entries.find((candidate) => candidate.matcher === 'rate_limit');
  if (!entry) {
    entry = { matcher: 'rate_limit', hooks: [] };
    entries.push(entry);
  }
  entry.hooks ||= [];
  if (!entry.hooks.some((hook) => hook.type === 'command' && hook.command === 'ccd hook rate-limit')) {
    entry.hooks.push({ type: 'command', command: 'ccd hook rate-limit' });
  }
  settings.hooks.StopFailure = entries;
  return settings;
}

function removeHook(settings) {
  const entries = Array.isArray(settings.hooks?.StopFailure) ? settings.hooks.StopFailure : [];
  for (const entry of entries) {
    entry.hooks = (entry.hooks || []).filter((hook) => hook.command !== 'ccd hook rate-limit');
  }
  if (settings.hooks) settings.hooks.StopFailure = entries.filter((entry) => (entry.hooks || []).length > 0);
  return settings;
}

export async function run(args = []) {
  const action = args[0] || 'status';
  if (action === 'rate-limit') {
    await runRateLimitHook(readStdin());
    return 0;
  }

  const account = parseAccount(args);
  if (!account) {
    process.stderr.write('Account not found.\n');
    return 1;
  }
  const file = settingsPath(account);

  if (action === 'install') {
    const modeIndex = args.indexOf('--mode');
    if (modeIndex >= 0) {
      const mode = args[modeIndex + 1];
      if (!['auto', 'notify'].includes(mode)) {
        process.stderr.write('Mode must be auto or notify.\n');
        return 1;
      }
      const config = loadConfig();
      config.autoSwitch.mode = mode;
      saveConfig(config);
    }
    fs.mkdirSync(account.dir, { recursive: true, mode: 0o700 });
    const settings = ensureHook(readJson(file) || {});
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    writeJsonAtomic(file, settings);
    process.stdout.write(`Installed StopFailure hook in ${file}\n`);
    return 0;
  }

  if (action === 'uninstall') {
    const settings = removeHook(readJson(file) || {});
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    writeJsonAtomic(file, settings);
    process.stdout.write(`Uninstalled StopFailure hook from ${file}\n`);
    return 0;
  }

  if (action === 'status') {
    const settings = readJson(file) || {};
    const installed = Array.isArray(settings.hooks?.StopFailure)
      && settings.hooks.StopFailure.some((entry) => (entry.hooks || []).some((hook) => hook.command === 'ccd hook rate-limit'));
    process.stdout.write(`${installed ? 'installed' : 'not installed'}\n`);
    return 0;
  }

  process.stderr.write('Usage: ccd hook install [--account <q>] [--mode auto|notify] | uninstall | status | rate-limit\n');
  return 1;
}
