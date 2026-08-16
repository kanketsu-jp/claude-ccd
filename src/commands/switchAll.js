import path from 'node:path';
import { resolveAccount } from '../accounts.js';
import { extractResumeSessionId, isClaudeProcess, parsePsOutput, runningClaudeProcesses } from '../launcher.js';
import { commandExists, run as runCommand, shellQuote } from '../util.js';

const DEFAULT_TERM_TIMEOUT_MS = 10000;
const DEFAULT_KILL_TIMEOUT_MS = 2000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_START_DELAY_MS = 8000;
// 起動確認はポーリングで待つ。claude の起動は MCP の接続を含むため実測で 34〜68 秒かかった
// （2026-08-17）。8 秒の一発判定では、起動していたものを failed と誤報する。
const DEFAULT_START_TIMEOUT_MS = 120000;
const DEFAULT_START_POLL_MS = 3000;

function envMs(name, fallback) {
  const value = Number(process.env[name] || 0);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function switchAllTiming(overrides = {}) {
  return {
    termTimeoutMs: Number(overrides.termTimeoutMs || 0) > 0 ? Number(overrides.termTimeoutMs) : envMs('CCD_SWITCH_ALL_TERM_TIMEOUT_MS', DEFAULT_TERM_TIMEOUT_MS),
    killTimeoutMs: Number(overrides.killTimeoutMs || 0) > 0 ? Number(overrides.killTimeoutMs) : envMs('CCD_SWITCH_ALL_KILL_TIMEOUT_MS', DEFAULT_KILL_TIMEOUT_MS),
    pollIntervalMs: Number(overrides.pollIntervalMs || 0) > 0 ? Number(overrides.pollIntervalMs) : envMs('CCD_SWITCH_ALL_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    startDelayMs: Number(overrides.startDelayMs || 0) > 0 ? Number(overrides.startDelayMs) : envMs('CCD_SWITCH_ALL_START_DELAY_MS', DEFAULT_START_DELAY_MS),
    startTimeoutMs: Number(overrides.startTimeoutMs || 0) > 0 ? Number(overrides.startTimeoutMs) : envMs('CCD_SWITCH_ALL_START_TIMEOUT_MS', DEFAULT_START_TIMEOUT_MS),
    startPollMs: Number(overrides.startPollMs || 0) > 0 ? Number(overrides.startPollMs) : envMs('CCD_SWITCH_ALL_START_POLL_MS', DEFAULT_START_POLL_MS),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonPanes(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const result = parsed?.result ?? parsed;
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.panes)) return result.panes;
    if (Array.isArray(result?.tabs)) return result.tabs.flatMap((tab) => tab.panes || (tab.root_pane ? [tab.root_pane] : []));
    return [];
  } catch {
    return [];
  }
}

function normalizePane(pane) {
  const id = pane.pane_id || pane.id || pane.paneId || pane.tmux_pane_id || null;
  const command = pane.command || pane.cmd || pane.command_line || pane.commandLine || '';
  return id ? { id, command } : null;
}

function listHerdrPanes() {
  const result = runCommand('herdr', ['pane', 'list']);
  if (result.status !== 0) return null;
  const panes = parseJsonPanes(result.stdout).map(normalizePane).filter(Boolean);
  return panes.length > 0 ? { launcher: 'herdr', panes } : null;
}

function listTmuxPanes() {
  const result = runCommand('tmux', ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}']);
  if (result.status !== 0) return null;
  const panes = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, pid] = line.split('\t');
      return id ? { id, pid: Number(pid) || null, command: '' } : null;
    })
    .filter(Boolean);
  return panes.length > 0 ? { launcher: 'tmux', panes } : null;
}

function parseProcessInfo(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed?.result?.process_info ?? parsed?.process_info ?? parsed?.result ?? parsed ?? null;
  } catch {
    return null;
  }
}

function commandForProcessInfo(proc) {
  if (Array.isArray(proc?.argv) && proc.argv.length > 0) return proc.argv.map(String).join(' ');
  return proc?.cmdline || proc?.command || proc?.args || '';
}

function normalizeProcessInfoProcess(proc, ppid = 0) {
  const pid = Number(proc?.pid || 0);
  if (!pid) return null;
  return {
    pid,
    ppid,
    comm: proc?.comm || proc?.name || proc?.argv0 || (Array.isArray(proc?.argv) ? proc.argv[0] : null),
    name: proc?.name || null,
    argv0: proc?.argv0 || null,
    argv: Array.isArray(proc?.argv) ? proc.argv : null,
    command: commandForProcessInfo(proc),
  };
}

function herdrForegroundClaude(info) {
  return (info?.foreground_processes || [])
    .map((proc) => normalizeProcessInfoProcess(proc, Number(info?.shell_pid || 0) || 0))
    .filter(Boolean)
    .find((proc) => isClaudeProcess(proc)) || null;
}

function listPanes() {
  if (commandExists('herdr')) {
    const herdr = listHerdrPanes();
    if (herdr) return herdr;
  }
  if (commandExists('tmux')) return listTmuxPanes();
  return null;
}

function isDescendant(proc, rootPid, byPid) {
  let current = proc;
  const seen = new Set();
  while (current && !seen.has(current.pid)) {
    if (current.pid === rootPid || current.ppid === rootPid) return true;
    seen.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return false;
}

function processForPane(pane, processes) {
  if (!pane.pid) return null;
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const directSession = extractResumeSessionId(pane.command);
  if (directSession) {
    const matched = processes.find((proc) => {
      if (extractResumeSessionId(proc.command) !== directSession) return false;
      return isDescendant(proc, pane.pid, byPid);
    });
    if (matched) return matched;
    return pane.pid ? { pid: pane.pid, ppid: 0, command: pane.command } : null;
  }
  return processes
    .map((proc) => ({ proc, sessionId: extractResumeSessionId(proc.command) }))
    .filter((entry) => entry.sessionId)
    .find((entry) => isDescendant(entry.proc, pane.pid, byPid))?.proc || null;
}

function processForHerdrPane(pane, processes, run = runCommand) {
  const result = run('herdr', ['pane', 'process-info', '--pane', pane.id]);
  if (result.status !== 0) return { proc: null, reason: 'process-info failed' };
  const info = parseProcessInfo(result.stdout);
  const foreground = herdrForegroundClaude(info);
  if (foreground) return { proc: foreground, reason: null };
  const shellPid = Number(info?.shell_pid || 0) || null;
  if (!shellPid) return { proc: null, reason: 'no claude process' };
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const child = processes.find((proc) => isClaudeProcess(proc) && extractResumeSessionId(proc.command) && isDescendant(proc, shellPid, byPid));
  return child ? { proc: child, reason: null } : { proc: null, reason: 'no claude process' };
}

function buildPlan(launcher, panes, processes, selfPaneId, includeSelf) {
  const plan = [];
  const self = [];
  const skipped = [];
  const usedPids = new Set();
  for (const pane of panes) {
    const resolved = launcher === 'herdr'
      ? processForHerdrPane(pane, processes)
      : { proc: processForPane(pane, processes), reason: 'no claude process' };
    const proc = resolved.proc;
    if (!proc) {
      skipped.push({ pane, reason: resolved.reason || 'no claude process' });
      continue;
    }
    const sessionId = extractResumeSessionId(proc.command);
    if (!sessionId) {
      skipped.push({ pane, pid: proc.pid, reason: 'no resume session' });
      continue;
    }
    const item = { pane, pid: proc.pid, sessionId };
    if (pane.id === selfPaneId && !includeSelf) {
      self.push(item);
    } else if (usedPids.has(proc.pid)) {
      skipped.push({ pane, pid: proc.pid, reason: 'duplicate pid' });
    } else {
      usedPids.add(proc.pid);
      plan.push(item);
    }
  }
  return { plan, skippedSelf: self, skipped };
}

function pidExists(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function waitUntilGone(pid, timeoutMs, pollIntervalMs, deps = {}) {
  const exists = deps.exists || ((targetPid) => pidExists(targetPid, deps.kill || process.kill));
  const sleepFn = deps.sleep || sleep;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (!exists(pid)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleepFn(Math.min(pollIntervalMs, remaining));
  }
}

export async function waitForProcessExit(pid, deps = {}) {
  const kill = deps.kill || process.kill;
  const timing = switchAllTiming(deps);
  try {
    kill(pid, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
  }
  if (await waitUntilGone(pid, timing.termTimeoutMs, timing.pollIntervalMs, { ...deps, kill })) return true;

  try {
    kill(pid, 'SIGKILL');
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
  }
  return waitUntilGone(pid, timing.killTimeoutMs, timing.pollIntervalMs, { ...deps, kill });
}

function ccdBinPath(argv1 = process.argv[1]) {
  return path.resolve(argv1 || 'ccd');
}

export function buildSwitchCommand(account, sessionId, ccdBin = ccdBinPath()) {
  // 🚨 既定アカウントへ切り替えるときは CLAUDE_CONFIG_DIR を「代入」せず「解除」する。
  // 代入すると Keychain のサービス名が `Claude Code-credentials-<hash>` になり、
  // 未設定時の `Claude Code-credentials` と別項目を見に行って「未ログイン」になる。
  // さらに、切替元のシェルに CLAUDE_CONFIG_DIR が残っていると新プロセスがそれを継承するため、
  // 明示的な `env -u` が必要（2026-08-17 実測: unset しないと切替後もまた元アカウントで起動した）。
  // launcher.js の buildLaunchCommand と同じ規約。
  const quoted = `${shellQuote(ccdBin)} --resume ${shellQuote(sessionId)}`;
  if (account.isDefault) return `env -u CLAUDE_CONFIG_DIR ${quoted}`;
  return `CLAUDE_CONFIG_DIR=${shellQuote(account.dir)} ${quoted}`;
}

function sendStartCommand(launcher, pane, command, run = runCommand) {
  if (launcher === 'herdr') return run('herdr', ['pane', 'run', pane.id, command]);
  return run('tmux', ['send-keys', '-t', pane.id, command, 'Enter']);
}

function processNameIsClaude(proc) {
  return path.basename(String(proc?.name || '')) === 'claude';
}

export function paneHasStartedClaude(launcher, pane, run = runCommand) {
  if (launcher === 'herdr') {
    const result = run('herdr', ['pane', 'process-info', '--pane', pane.id]);
    if (result.status !== 0) return false;
    const info = parseProcessInfo(result.stdout);
    return (info?.foreground_processes || []).some((proc) => processNameIsClaude(proc));
  }
  const proc = processForPane(pane, runningClaudeProcesses());
  return Boolean(proc && isClaudeProcess(proc));
}

export async function switchPane(launcher, item, account, deps = {}) {
  const run = deps.runCommand || runCommand;
  const sleepFn = deps.sleep || sleep;
  const timing = switchAllTiming(deps);
  const exited = await waitForProcessExit(item.pid, deps);
  if (!exited) return { ok: false, skipped: true, reason: `process ${item.pid} did not exit` };

  const command = buildSwitchCommand(account, item.sessionId, deps.ccdBin || ccdBinPath());
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const started = sendStartCommand(launcher, item.pane, command, run);
    if (started.status !== 0) {
      return { ok: false, failed: true, reason: started.stderr || started.stdout || `failed to switch pane ${item.pane.id}` };
    }
    // 🚨 一度きりの待ちで判定してはならない。claude の起動は MCP の接続を含むため
    //    実測で 34〜68 秒かかる（2026-08-17）。8 秒で判定していたとき、実際には
    //    起動していた 3 件すべてを failed と誤報し、無駄な再投入まで走った。
    //    起動を待つのはポーリングで行い、上限まで粘る。
    const deadline = Date.now() + timing.startTimeoutMs;
    let seen = false;
    while (Date.now() < deadline) {
      await sleepFn(Math.min(timing.startPollMs, Math.max(0, deadline - Date.now())));
      if (paneHasStartedClaude(launcher, item.pane, run)) { seen = true; break; }
    }
    if (seen) return { ok: true };
  }
  return { ok: false, failed: true, reason: `claude did not start (sid ${item.sessionId})` };
}

export async function runSwitchAll(args = [], options = {}) {
  const out = options.stdout || ((text) => process.stdout.write(text));
  const err = options.stderr || ((text) => process.stderr.write(text));
  const finish = (exitCode, detail = {}) => {
    if (options.returnResult) return { exitCode, switchedCount: 0, failedCount: 0, skippedCount: 0, ...detail };
    return exitCode;
  };
  const dryRun = args.includes('--dry-run');
  const includeSelf = args.includes('--include-self');
  // 一度に全ペインを切り替えるのは、失敗したときの被害が大きい（2026-08-15 に 34 ペインを
  // 一括で落とした）。少数で挙動を確かめてから広げられるようにする。
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 0;
  if (limitIdx >= 0 && (!Number.isInteger(limit) || limit < 1)) {
    err('--limit takes a positive integer\n');
    return finish(1);
  }
  // 🚨 limitIdx が -1 のとき limitIdx+1 は 0 になり、先頭の引数（アカウント名）を
  //    除外してしまう。--limit が実際に指定されているときだけ、その次の引数を飛ばす。
  const query = args.find((arg, i) => !arg.startsWith('--') && !(limitIdx >= 0 && i === limitIdx + 1));
  if (!query) {
    err('Usage: ccd switch-all <name|email> [--dry-run] [--include-self] [--limit N]\n');
    return finish(1);
  }
  const resolved = resolveAccount(query);
  if (resolved.error) {
    err(`Account ${resolved.error}\n`);
    return finish(1);
  }
  const listed = listPanes();
  if (!listed) {
    err('No pane launcher found (herdr or tmux required).\n');
    return finish(1);
  }
  const processes = runningClaudeProcesses();
  const { plan: fullPlan, skippedSelf, skipped } = buildPlan(listed.launcher, listed.panes, processes, process.env.HERDR_PANE_ID || '', includeSelf);
  // --limit は「先頭から N 件だけ処理する」。残りは黙って消さず、件数を明示する
  // （何件を見送ったかが出ないと、全部やったのか一部なのか報告から読めない）
  const plan = limit > 0 ? fullPlan.slice(0, limit) : fullPlan;
  const deferred = fullPlan.length - plan.length;
  let skippedCount = skippedSelf.length + skipped.length;
  let switchedCount = 0;
  let failedCount = 0;
  for (const item of skippedSelf) out(`skip self ${item.pane.id} ${item.sessionId}\n`);
  for (const item of skipped) out(`skip pane ${item.pane.id}${item.pid ? ` pid ${item.pid}` : ''}: ${item.reason}\n`);
  for (const item of plan) {
    out(`${dryRun ? 'dry-run ' : ''}pane ${item.pane.id} pid ${item.pid} resume ${item.sessionId} -> ${resolved.account.name}\n`);
    if (!dryRun) {
      const result = await switchPane(listed.launcher, item, resolved.account);
      if (result.ok) {
        switchedCount += 1;
      } else if (result.skipped) {
        skippedCount += 1;
        out(`skip pane ${item.pane.id}: ${result.reason}\n`);
      } else {
        failedCount += 1;
        out(`failed pane ${item.pane.id}: ${result.reason}\n`);
      }
    }
  }
  out(`switched ${switchedCount} / failed ${failedCount} / skipped ${skippedCount}${deferred > 0 ? ` / deferred ${deferred} (--limit ${limit})` : ''}\n`);
  return finish(failedCount > 0 ? 1 : 0, { switchedCount, failedCount, skippedCount, deferredCount: deferred, plannedCount: plan.length });
}

export { parsePsOutput };
export const run = runSwitchAll;
