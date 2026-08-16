import { chooseHealthyAccount, currentDir, isHealthy, listAccounts, orderAccounts, readAccount } from './accounts.js';
import { runSwitchAll } from './commands/switchAll.js';
import { loadConfig, saveConfig } from './config.js';
import { launchAccount, launchNone } from './launcher.js';
import { notify } from './notify.js';
import { loadState, recordEvent, recordRateLimit, recordSwitch, recordUsageFailover, switchesInLastHour } from './state.js';

// StopFailure は stdout も exit code も無視するため、これは手動実行時のためだけの出力。
// ユーザーに届くのは notify() と、あとから読める state の lastEvent。
function report(kind, message) {
  recordEvent(kind, message);
  process.stdout.write(JSON.stringify({ systemMessage: message }) + '\n');
}

// `rate_limit` は「アカウントが使えなくなった」以外の状況でも発火する。
// 上限に当たってもモデルのフォールバックで応答が続いた場合、Claude Code は
// ユーザーに何も見せない代わりに定型の内部メッセージを最後の応答として残す。
// これを切り替えの合図と取ると、実際には作業が続いているのにペインが増えてしまう。
const HANDLED_ELSEWHERE_MESSAGES = new Set(['No response requested.']);

function isHandledElsewhere(payload) {
  const last = typeof payload.last_assistant_message === 'string'
    ? payload.last_assistant_message.trim()
    : '';
  return HANDLED_ELSEWHERE_MESSAGES.has(last);
}

function parsePayload(input) {
  try {
    return typeof input === 'string' ? JSON.parse(input || '{}') : (input || {});
  } catch {
    return {};
  }
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function usagePercent(payload, override) {
  const overridden = numberOrNull(override);
  if (overridden != null) return overridden;
  return numberOrNull(payload?.rate_limits?.seven_day?.used_percentage);
}

function resetSeconds(payload) {
  const value = numberOrNull(payload?.rate_limits?.seven_day?.resets_at);
  if (value != null && value > 0) return value;
  return Math.ceil((Date.now() + 24 * 60 * 60 * 1000) / 1000);
}

function isUsageFailoverRecorded(state, accountName) {
  const last = state.lastUsageFailover;
  if (!last || last.account !== accountName) return false;
  const resetMs = Number(last.resetsAt || 0) * 1000;
  return resetMs > Date.now();
}

export async function runUsageHook(input, options = {}) {
  try {
    const payload = parsePayload(input);
    const config = loadConfig();
    const auto = config.autoSwitch || {};
    if (auto.mode === 'off') return 0;

    const threshold = numberOrNull(auto.usageThreshold);
    if (!threshold) return 0;

    const used = usagePercent(payload, options.used);
    if (used == null || used < threshold) return 0;

    const current = readAccount(currentDir());
    if (auto.usageWatch && String(auto.usageWatch) !== current.name) return 0;

    const state = loadState();
    if (isUsageFailoverRecorded(state, current.name)) return 0;

    const accounts = listAccounts();
    const next = chooseHealthyAccount(accounts, state, config, { excludeName: current.name });
    if (!next) {
      notify('Claude usage failover failed', 'No logged-in account is available for switching.');
      report('failed', `Usage failover failed: no alternate logged-in account is available (${used}% >= ${threshold}%).`);
      return 0;
    }

    const result = await runSwitchAll([next.name, '--include-self'], {
      returnResult: true,
      stdout: () => {},
      stderr: () => {},
    });

    if (result.exitCode === 0 && result.switchedCount > 0) {
      if (auto.updateDefault !== false) saveConfig({ ...config, preferredAccount: next.name });
      recordUsageFailover({ account: current.name, resetsAt: resetSeconds(payload), at: Date.now() });
      notify('Claude usage failover', `Switched ${result.switchedCount} pane(s) from ${current.name} to ${next.name}.`);
      report('usage-switched', `Usage failover: ${used}% >= ${threshold}%. Switched ${result.switchedCount} pane(s) from ${current.name} to ${next.name}.`);
      return 0;
    }

    const detail = result.exitCode === 0 && result.switchedCount === 0
      ? 'no panes were switched'
      : `${result.failedCount || 0} pane(s) failed`;
    notify('Claude usage failover failed', detail);
    report('failed', `Usage failover failed: ${detail} (${used}% >= ${threshold}%).`);
  } catch (error) {
    process.stderr.write(`ccd hook usage error: ${error?.message || String(error)}\n`);
  }
  return 0;
}

export async function runRateLimitHook(input) {
  try {
    const payload = typeof input === 'string' ? JSON.parse(input || '{}') : (input || {});
    const config = loadConfig();
    const auto = config.autoSwitch || {};
    if (auto.mode === 'off') return 0;
    if (payload.error && payload.error !== 'rate_limit') return 0;
    if (isHandledElsewhere(payload)) return 0;

    const current = readAccount(currentDir());
    recordRateLimit(current);
    const state = loadState();
    const sessionId = payload.session_id || null;
    const accounts = listAccounts();
    const nextDefault = auto.updateDefault !== false
      ? chooseHealthyAccount(accounts, state, config, { excludeName: current.name })
      : null;
    let defaultUpdateMessage = '';
    if (nextDefault) {
      const updated = { ...config, preferredAccount: nextDefault.name };
      saveConfig(updated);
      defaultUpdateMessage = ` Preferred account changed to ${nextDefault.name}.`;
    }

    if (switchesInLastHour(state) >= Number(auto.maxSwitchesPerHour || 0)) {
      notify('Claude account rate limited', 'Switch limit reached. No account was launched.');
      report('blocked', `Rate limit detected, but switch limit has been reached.${defaultUpdateMessage}`);
      return 0;
    }

    const last = sessionId ? state.lastSwitchBySession?.[sessionId] : null;
    if (last && Date.now() - last < Number(auto.minIntervalMinutes || 0) * 60 * 1000) {
      notify('Claude account rate limited', 'Minimum switch interval has not elapsed.');
      report('blocked', `Rate limit detected, but minimum switch interval has not elapsed.${defaultUpdateMessage}`);
      return 0;
    }

    const candidates = orderAccounts(accounts, auto.order)
      .filter((account) => account.name !== current.name)
      .filter((account) => isHealthy(account, state, config));

    if (candidates.length === 0) {
      notify('Claude account rate limited', 'No logged-in account is available for switching.');
      report('no-candidate', `Rate limit detected, but no alternate logged-in account is available.${defaultUpdateMessage}`);
      return 0;
    }

    const next = candidates[0];
    if (auto.mode === 'notify') {
      const preview = launchNone(next, {
        fromAccount: current,
        cwd: payload.cwd || process.cwd(),
        sessionId,
        transcriptPath: payload.transcript_path || null,
        resume: auto.resume !== false,
      });
      const command = preview.detail;
      notify('Claude account available', `${next.name}: ${command}`);
      report('suggested', `Rate limit detected. Suggested account: ${next.name}. Command: ${command}.${defaultUpdateMessage}`);
      return 0;
    }

    const result = launchAccount(next, {
      config,
      fromAccount: current,
      cwd: payload.cwd || process.cwd(),
      sessionId,
      transcriptPath: payload.transcript_path || null,
      resume: auto.resume !== false,
      continueMessage: auto.resume === false ? null : auto.continueMessage,
    });

    if (result.ok) {
      recordSwitch({ at: Date.now(), fromName: current.name, toName: next.name, sessionId });
      notify('Claude account switched', `Launched ${next.name} with ${result.launcher}.`);
      report('switched', `Rate limit detected. Launched ${next.name} with ${result.launcher}.${defaultUpdateMessage}`);
    } else {
      notify('Claude account switch failed', String(result.detail || 'Unknown launcher error'));
      report('failed', `Rate limit detected, but launch failed: ${result.detail || 'unknown error'}.${defaultUpdateMessage}`);
    }
  } catch (error) {
    process.stderr.write(`ccd hook error: ${error?.message || String(error)}\n`);
  }
  return 0;
}
