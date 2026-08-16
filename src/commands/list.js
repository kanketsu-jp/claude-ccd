import { currentDir, listAccounts, rateLimitedAtFor } from '../accounts.js';
import { loadConfig } from '../config.js';
import { loadState } from '../state.js';
import { shortenHome, table } from '../util.js';

function coolingText(state, account, minutes, accounts) {
  // 同じメールの別 config dir で記録されたレートリミットも数える（クォータは共有されるため）
  const at = rateLimitedAtFor(account, state, accounts);
  if (!at) return '';
  const remaining = Math.ceil((at + minutes * 60 * 1000 - Date.now()) / 60000);
  return remaining > 0 ? ` (cooling ${remaining}m)` : '';
}

function quotaShareText(account, firstByEmail) {
  if (!account.email) return '';
  const first = firstByEmail.get(account.email.toLowerCase());
  return first && first !== account.name ? ` (shares quota with ${first})` : '';
}

export function run(args = []) {
  const json = args.includes('--json');
  const accounts = listAccounts();
  const current = currentDir();
  const config = loadConfig();
  const state = loadState();
  if (json) {
    process.stdout.write(JSON.stringify(accounts, null, 2) + '\n');
    return 0;
  }
  const firstByEmail = new Map();
  for (const account of accounts) {
    if (!account.email) continue;
    const email = account.email.toLowerCase();
    if (!firstByEmail.has(email)) firstByEmail.set(email, account.name);
  }
  const rows = accounts.map((account) => [
    account.dir === current ? '*' : ' ',
    account.name,
    shortenHome(account.dir),
    (account.email || '-') + quotaShareText(account, firstByEmail),
    account.plan || '-',
    (account.loggedIn ? 'yes' : 'no') + coolingText(state, account, config.autoSwitch.cooldownMinutes, accounts),
  ]);
  process.stdout.write(table(rows, [' ', 'NAME', 'CONFIG DIR', 'ACCOUNT', 'PLAN', 'LOGIN']) + '\n');
  return 0;
}
