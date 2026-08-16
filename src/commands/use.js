import { currentDir, resolveAccount } from '../accounts.js';
import { loadConfig } from '../config.js';
import { copySessionHistory } from '../sessions.js';
import { shellQuote, shortenHome } from '../util.js';

// --shell / --sessions は値を取るため、値ごと取り除いてから位置引数 (アカウント名) を探す。
// 取り除き忘れると値のほうをアカウント名と誤認する。
function parseArgs(args) {
  const parsed = { shell: 'posix', sessions: null, noSessions: false, quiet: false, positional: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--shell') {
      parsed.shell = args[i + 1] || 'posix';
      i += 1;
    } else if (arg.startsWith('--shell=')) {
      parsed.shell = arg.slice('--shell='.length);
    } else if (arg === '--sessions') {
      parsed.sessions = args[i + 1] || null;
      i += 1;
    } else if (arg.startsWith('--sessions=')) {
      parsed.sessions = arg.slice('--sessions='.length);
    } else if (arg === '--no-sessions') {
      parsed.noSessions = true;
    } else if (arg === '--quiet') {
      parsed.quiet = true;
    } else if (!arg.startsWith('-')) {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

function sessionLimit(parsed, config) {
  const configured = config.copySessions?.limit;
  const fallback = Number.isFinite(configured) ? configured : 5;
  if (parsed.sessions == null) return fallback;
  if (parsed.sessions === 'all') return 0;
  const value = Number(parsed.sessions);
  return Number.isFinite(value) ? value : fallback;
}

// 履歴コピーは「切替そのもの」より優先度が低い。ここで失敗しても
// export を出して切替は成立させる (stdout はシェルが eval するので絶対に汚さない)。
function copySessions(fromDir, account, parsed, config) {
  if (parsed.noSessions || config.copySessions?.enabled === false) return;
  let result;
  try {
    result = copySessionHistory(fromDir, account.dir, process.cwd(), { limit: sessionLimit(parsed, config) });
  } catch (error) {
    if (!parsed.quiet) process.stderr.write(`ccd: session copy failed — ${error?.message || String(error)}\n`);
    return;
  }
  if (parsed.quiet) return;
  if (result.status.startsWith('error:')) {
    process.stderr.write(`ccd: session copy failed — ${result.status.slice('error:'.length).trim()}\n`);
    return;
  }
  if (result.copied.length > 0) {
    process.stderr.write(`ccd: copied ${result.copied.length} session file(s) for ${shortenHome(process.cwd())} → ${shortenHome(result.to)}\n`);
  } else if (process.env.CCD_DEBUG === '1') {
    process.stderr.write(`ccd: session copy ${result.status} (skipped ${result.skipped.length})\n`);
  }
}

export function run(args = []) {
  const parsed = parseArgs(args);
  const query = parsed.positional[0];
  if (!query) {
    process.stderr.write('usage: ccd use <name|email> [--no-sessions] [--sessions <n|all>]\n');
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

  // 切替先で `claude --continue` / `--resume` が今の会話を拾えるよう、
  // 今いる cwd の履歴を切替元の config dir からコピーしておく。
  copySessions(currentDir(), account, parsed, loadConfig());

  if (parsed.shell === 'fish') {
    process.stdout.write(account.isDefault ? 'set -e CLAUDE_CONFIG_DIR\n' : `set -gx CLAUDE_CONFIG_DIR ${shellQuote(account.dir)}\n`);
  } else {
    process.stdout.write(account.isDefault ? 'unset CLAUDE_CONFIG_DIR\n' : `export CLAUDE_CONFIG_DIR=${shellQuote(account.dir)}\n`);
  }
  // 確認メッセージは stderr へ。stdout はシェル関数が eval するため汚してはいけない。
  if (!parsed.quiet) {
    const who = account.email ? ` (${account.email})` : '';
    const where = account.isDefault ? 'default account' : shortenHome(account.dir);
    process.stderr.write(`ccd: now using ${account.name} → ${where}${who}\n`);
    if (!account.loggedIn) {
      process.stderr.write(`ccd: warning — ${account.name} is not logged in. Run: ccd run ${account.name}  then /login\n`);
    }
  }
  return 0;
}
