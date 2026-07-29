import fs from 'node:fs';
import { currentDir, readAccount, resolveAccount } from '../accounts.js';
import { shortenHome } from '../util.js';

export function run(args = []) {
  const json = args.includes('--json');
  const query = args.find((arg) => arg !== '--json');
  let account;
  if (query) {
    const resolved = resolveAccount(query);
    if (resolved.error) {
      process.stderr.write(`Account ${resolved.error}\n`);
      return 1;
    }
    account = resolved.account;
  } else {
    account = readAccount(currentDir());
  }
  const payload = {
    ...account,
    configFileExists: fs.existsSync(account.configFile),
    currentEnv: process.env.CLAUDE_CONFIG_DIR || null,
  };
  if (json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(`Name: ${account.name}\n`);
  process.stdout.write(`Config dir: ${shortenHome(account.dir)}\n`);
  process.stdout.write(`Config file: ${shortenHome(account.configFile)} (${payload.configFileExists ? 'exists' : 'missing'})\n`);
  process.stdout.write(`Account: ${account.email || '-'}\n`);
  process.stdout.write(`Plan: ${account.plan || '-'}\n`);
  process.stdout.write(`Tier: ${account.tier || '-'}\n`);
  process.stdout.write(`Keychain service: ${account.keychainService}\n`);
  process.stdout.write(`Logged in: ${account.loggedIn ? 'yes' : 'no'}\n`);
  process.stdout.write(`Current CLAUDE_CONFIG_DIR: ${payload.currentEnv ? shortenHome(payload.currentEnv) : '(unset)'}\n`);
  return 0;
}
