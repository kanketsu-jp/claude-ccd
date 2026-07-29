import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { commandExists, projectKey, run, shellQuote } from './util.js';

export function detectLauncher(config = loadConfig()) {
  const desired = config.autoSwitch?.launcher || 'auto';
  if (desired !== 'auto') return desired;
  if (process.env.HERDR_PANE_ID && commandExists('herdr')) return 'herdr';
  if (process.env.TMUX && commandExists('tmux')) return 'tmux';
  return 'none';
}

export function claudeBin(config = loadConfig()) {
  return config.claudeBin || 'claude';
}

export function buildCommand(account, { resumeSessionId = null, extraArgs = [] } = {}) {
  const config = loadConfig();
  const args = [...(config.launchArgs || []), ...extraArgs];
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  const quoted = [claudeBin(config), ...args].map(shellQuote).join(' ');
  if (account.isDefault) return `env -u CLAUDE_CONFIG_DIR ${quoted}`;
  return `CLAUDE_CONFIG_DIR=${shellQuote(account.dir)} ${quoted}`;
}

export function linkSessionHistory(fromAccount, toAccount, cwd, sessionId) {
  if (!fromAccount || !toAccount || !sessionId) return false;
  const key = projectKey(cwd);
  const source = path.join(fromAccount.dir, 'projects', key, `${sessionId}.jsonl`);
  const targetDir = path.join(toAccount.dir, 'projects', key);
  const target = path.join(targetDir, `${sessionId}.jsonl`);
  try {
    if (!fs.existsSync(source)) return false;
    fs.mkdirSync(targetDir, { recursive: true });
    if (!fs.existsSync(target)) fs.symlinkSync(source, target);
    return true;
  } catch {
    return false;
  }
}

function resumeIdForLaunch(fromAccount, toAccount, cwd, sessionId, resume) {
  if (!resume || !sessionId) return null;
  return linkSessionHistory(fromAccount, toAccount, cwd, sessionId) ? sessionId : null;
}

// herdr の応答は {"id": "<request id>", "result": {"type": "pane_info", "pane": {...}}} という
// エンベロープ。トップレベルの `id` はリクエスト識別子 (例 "cli:pane:split") でペイン ID ではないため、
// 決してフォールバック先にしない。
export function extractPaneId(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const result = parsed?.result ?? parsed;
    const paneId = result?.pane?.pane_id ?? result?.root_pane?.pane_id ?? result?.pane_id ?? null;
    return typeof paneId === 'string' && paneId.length > 0 ? paneId : null;
  } catch {
    return null;
  }
}

export function launchHerdr(account, options = {}) {
  const cwd = options.cwd || process.cwd();
  const resumeSessionId = resumeIdForLaunch(options.fromAccount, account, cwd, options.sessionId, options.resume);
  const splitArgs = ['pane', 'split', '--direction', 'right', '--cwd', cwd, '--focus'];
  if (!account.isDefault) splitArgs.splice(splitArgs.length - 1, 0, '--env', `CLAUDE_CONFIG_DIR=${account.dir}`);
  const split = run('herdr', splitArgs);
  if (split.status !== 0) return { ok: false, launcher: 'herdr', detail: split.stderr || split.stdout };
  const paneId = extractPaneId(split.stdout);
  if (!paneId) return { ok: false, launcher: 'herdr', detail: 'Could not read pane id from herdr output' };

  const command = buildCommand(account, { resumeSessionId, extraArgs: options.extraArgs || [] });
  const started = run('herdr', ['pane', 'run', paneId, command]);
  if (started.status !== 0) return { ok: false, launcher: 'herdr', detail: started.stderr || started.stdout };
  if (resumeSessionId && options.continueMessage) {
    run('herdr', ['wait', 'agent-status', paneId, '--status', 'idle', '--timeout', '120000']);
    run('herdr', ['agent', 'send', paneId, options.continueMessage]);
    run('herdr', ['pane', 'send-keys', paneId, 'Enter']);
  }
  return { ok: true, launcher: 'herdr', detail: paneId };
}

export function launchTmux(account, options = {}) {
  const cwd = options.cwd || process.cwd();
  const resumeSessionId = resumeIdForLaunch(options.fromAccount, account, cwd, options.sessionId, options.resume);
  const command = buildCommand(account, { resumeSessionId, extraArgs: options.extraArgs || [] });
  const result = run('tmux', ['split-window', '-h', '-c', cwd, '-P', '-F', '#{pane_id}', command]);
  if (result.status !== 0) return { ok: false, launcher: 'tmux', detail: result.stderr || result.stdout };
  const pane = result.stdout.trim();
  if (resumeSessionId && options.continueMessage) run('tmux', ['send-keys', '-t', pane, options.continueMessage, 'Enter']);
  return { ok: true, launcher: 'tmux', detail: pane || command };
}

export function launchNone(account, options = {}) {
  const cwd = options.cwd || process.cwd();
  const resumeSessionId = resumeIdForLaunch(options.fromAccount, account, cwd, options.sessionId, options.resume);
  return { ok: true, launcher: 'none', detail: buildCommand(account, { resumeSessionId, extraArgs: options.extraArgs || [] }) };
}

export function launchAccount(account, options = {}) {
  const launcher = detectLauncher(options.config || loadConfig());
  if (launcher === 'herdr') return launchHerdr(account, options);
  if (launcher === 'tmux') return launchTmux(account, options);
  return launchNone(account, options);
}
