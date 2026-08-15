import { chooseHealthyAccount, listAccounts, resolveAccount, resolveDefaultAccount } from '../accounts.js';
import { loadConfig, saveConfig } from '../config.js';
import { loadState } from '../state.js';
import { shortenHome } from '../util.js';

function describe(account, source) {
  const where = account.isDefault ? '~/.claude' : shortenHome(account.dir);
  const email = account.email ? ` <${account.email}>` : '';
  return `default: ${account.name}${email} (${where}) [${source}]\n`;
}

export function run(args = []) {
  const config = loadConfig();
  if (args.includes('--clear')) {
    config.preferredAccount = null;
    saveConfig(config);
    process.stdout.write(describe(resolveDefaultAccount(config), 'fallback'));
    return 0;
  }

  if (args.includes('--auto')) {
    const account = chooseHealthyAccount(listAccounts(), loadState(), config);
    if (!account) {
      process.stderr.write('No healthy logged-in account found.\n');
      return 1;
    }
    config.preferredAccount = account.name;
    saveConfig(config);
    process.stdout.write(describe(account, 'config'));
    return 0;
  }

  const query = args.find((arg) => !arg.startsWith('--'));
  if (query) {
    const resolved = resolveAccount(query);
    if (resolved.error) {
      const suffix = resolved.error === 'ambiguous'
        ? `: ${resolved.matches.map((a) => `${a.name} <${a.email || a.dir}>`).join(', ')}`
        : '';
      process.stderr.write(`Account ${resolved.error}${suffix}\n`);
      return 1;
    }
    config.preferredAccount = resolved.account.name;
    saveConfig(config);
    process.stdout.write(describe(resolved.account, 'config'));
    return 0;
  }

  const preferred = config.preferredAccount ? resolveAccount(config.preferredAccount) : null;
  if (preferred?.account) {
    process.stdout.write(describe(preferred.account, 'config'));
  } else {
    process.stdout.write(describe(resolveDefaultAccount(config), 'fallback'));
  }
  return 0;
}
