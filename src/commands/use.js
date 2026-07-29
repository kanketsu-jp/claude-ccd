import { resolveAccount } from '../accounts.js';
import { shellQuote, shortenHome } from '../util.js';

export function run(args = []) {
  const shellIndex = args.indexOf('--shell');
  const shell = shellIndex >= 0 ? args[shellIndex + 1] : 'posix';
  // --shell が無いとき shellIndex は -1。そのまま shellIndex + 1 で除外すると
  // 添字 0 (= 実引数) を捨ててしまうため、指定があるときだけ除外する。
  const rest = shellIndex >= 0
    ? args.filter((_, i) => i !== shellIndex && i !== shellIndex + 1)
    : args;
  const query = rest.find((a) => !a.startsWith('-'));
  if (!query) {
    process.stderr.write('usage: ccd use <name|email>\n');
    return 1;
  }
  const resolved = resolveAccount(query);
  if (resolved.error) {
    const suffix = resolved.error === 'ambiguous'
      ? `: ${resolved.matches.map((a) => `${a.name} <${a.email || a.dir}>`).join(', ')}`
      : '';
    process.stderr.write(`Account ${resolved.error}${suffix}\n`);
    return 1;
  }
  const account = resolved.account;
  if (shell === 'fish') {
    process.stdout.write(account.isDefault ? 'set -e CLAUDE_CONFIG_DIR\n' : `set -gx CLAUDE_CONFIG_DIR ${shellQuote(account.dir)}\n`);
  } else {
    process.stdout.write(account.isDefault ? 'unset CLAUDE_CONFIG_DIR\n' : `export CLAUDE_CONFIG_DIR=${shellQuote(account.dir)}\n`);
  }
  // 確認メッセージは stderr へ。stdout はシェル関数が eval するため汚してはいけない。
  if (!args.includes('--quiet')) {
    const who = account.email ? ` (${account.email})` : '';
    const where = account.isDefault ? 'default account' : shortenHome(account.dir);
    process.stderr.write(`ccd: now using ${account.name} → ${where}${who}\n`);
    if (!account.loggedIn) {
      process.stderr.write(`ccd: warning — ${account.name} is not logged in. Run: ccd run ${account.name}  then /login\n`);
    }
  }
  return 0;
}
