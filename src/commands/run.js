import { spawnSync } from 'node:child_process';
import { envForAccount, resolveAccount } from '../accounts.js';
import { loadConfig } from '../config.js';
import { commandExists, expandArgAliases } from '../util.js';

export function run(args = []) {
  const query = args[0];
  if (!query) {
    process.stderr.write('Usage: ccd run <account> [args...]\n');
    return 1;
  }
  const resolved = resolveAccount(query);
  if (resolved.error) {
    process.stderr.write(`Account ${resolved.error}\n`);
    return 1;
  }
  const config = loadConfig();
  const bin = config.claudeBin || 'claude';
  if (!commandExists(bin)) {
    process.stderr.write(`Claude binary not found: ${bin}\n`);
    return 1;
  }
  const result = spawnSync(bin, [...(config.launchArgs || []), ...expandArgAliases(args.slice(1), config)], {
    stdio: 'inherit',
    env: envForAccount(resolved.account),
  });
  return typeof result.status === 'number' ? result.status : 1;
}
