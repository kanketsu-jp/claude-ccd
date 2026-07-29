import { currentDir, listAccounts, readAccount } from './accounts.js';
import { loadConfig } from './config.js';
import { launchAccount, launchNone } from './launcher.js';
import { notify } from './notify.js';
import { loadState, recordRateLimit, recordSwitch, switchesInLastHour } from './state.js';

function jsonLine(systemMessage) {
  process.stdout.write(JSON.stringify({ systemMessage }) + '\n');
}

function isCooling(state, name, minutes) {
  const at = state.rateLimited?.[name];
  return at && Date.now() - at < minutes * 60 * 1000;
}

function orderAccounts(accounts, order) {
  if (!Array.isArray(order) || order.length === 0) return accounts;
  const rank = new Map(order.map((name, i) => [String(name), i]));
  return [...accounts].sort((a, b) => (rank.get(a.name) ?? 9999) - (rank.get(b.name) ?? 9999));
}

export async function runRateLimitHook(input) {
  try {
    const payload = typeof input === 'string' ? JSON.parse(input || '{}') : (input || {});
    const config = loadConfig();
    const auto = config.autoSwitch || {};
    if (auto.mode === 'off') return 0;
    if (payload.error && payload.error !== 'rate_limit') return 0;

    const current = readAccount(currentDir());
    recordRateLimit(current.name);
    const state = loadState();
    const sessionId = payload.session_id || null;

    if (switchesInLastHour(state) >= Number(auto.maxSwitchesPerHour || 0)) {
      notify('Claude account rate limited', 'Switch limit reached. No account was launched.');
      jsonLine('Rate limit detected, but switch limit has been reached.');
      return 0;
    }

    const last = sessionId ? state.lastSwitchBySession?.[sessionId] : null;
    if (last && Date.now() - last < Number(auto.minIntervalMinutes || 0) * 60 * 1000) {
      notify('Claude account rate limited', 'Minimum switch interval has not elapsed.');
      jsonLine('Rate limit detected, but minimum switch interval has not elapsed.');
      return 0;
    }

    const cooldown = Number(auto.cooldownMinutes || 0);
    const candidates = orderAccounts(listAccounts(), auto.order)
      .filter((account) => account.name !== current.name)
      .filter((account) => account.loggedIn)
      .filter((account) => !isCooling(state, account.name, cooldown));

    if (candidates.length === 0) {
      notify('Claude account rate limited', 'No logged-in account is available for switching.');
      jsonLine('Rate limit detected, but no alternate logged-in account is available.');
      return 0;
    }

    const next = candidates[0];
    if (auto.mode === 'notify') {
      const preview = launchNone(next, {
        fromAccount: current,
        cwd: payload.cwd || process.cwd(),
        sessionId,
        resume: auto.resume !== false,
      });
      const command = preview.detail;
      notify('Claude account available', `${next.name}: ${command}`);
      jsonLine(`Rate limit detected. Suggested account: ${next.name}. Command: ${command}`);
      return 0;
    }

    const result = launchAccount(next, {
      config,
      fromAccount: current,
      cwd: payload.cwd || process.cwd(),
      sessionId,
      resume: auto.resume !== false,
      continueMessage: auto.resume === false ? null : auto.continueMessage,
    });

    if (result.ok) {
      recordSwitch({ at: Date.now(), fromName: current.name, toName: next.name, sessionId });
      notify('Claude account switched', `Launched ${next.name} with ${result.launcher}.`);
      jsonLine(`Rate limit detected. Launched ${next.name} with ${result.launcher}.`);
    } else {
      notify('Claude account switch failed', String(result.detail || 'Unknown launcher error'));
      jsonLine(`Rate limit detected, but launch failed: ${result.detail || 'unknown error'}`);
    }
  } catch (error) {
    process.stderr.write(`ccd hook error: ${error?.message || String(error)}\n`);
  }
  return 0;
}
