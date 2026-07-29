import { currentDir, listAccounts } from '../accounts.js';
import { loadConfig } from '../config.js';
import { loadState } from '../state.js';
import { shortenHome, table } from '../util.js';

function coolingText(state, name, minutes) {
  const at = state.rateLimited?.[name];
  if (!at) return '';
  const remaining = Math.ceil((at + minutes * 60 * 1000 - Date.now()) / 60000);
  return remaining > 0 ? ` (cooling ${remaining}m)` : '';
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
  const rows = accounts.map((account) => [
    account.dir === current ? '*' : ' ',
    account.name,
    shortenHome(account.dir),
    account.email || '-',
    account.plan || '-',
    (account.loggedIn ? 'yes' : 'no') + coolingText(state, account.name, config.autoSwitch.cooldownMinutes),
  ]);
  process.stdout.write(table(rows, [' ', 'NAME', 'CONFIG DIR', 'ACCOUNT', 'PLAN', 'LOGIN']) + '\n');
  return 0;
}
