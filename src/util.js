import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function sha256Hex8(s) {
  return createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
}

export function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (typeof p === 'string' && p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function stripTrailingSlash(p) {
  if (!p) return p;
  let out = p;
  while (out.length > 1 && /[\\/]$/.test(out)) out = out.slice(0, -1);
  return out;
}

export function shortenHome(p) {
  const home = stripTrailingSlash(os.homedir());
  const target = stripTrailingSlash(String(p || ''));
  if (target === home) return '~';
  if (target.startsWith(home + path.sep)) return '~' + target.slice(home.length);
  return target;
}

export function run(cmd, args = [], opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    ...opts,
  });
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? String(result.error.message || result.error) : ''),
  };
}

export function commandExists(cmd) {
  if (!cmd || cmd.includes(path.sep)) return fs.existsSync(cmd);
  const pathValue = process.env.PATH || '';
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT || '').split(path.delimiter) : [''];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const file = path.join(dir, cmd + ext);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return true;
      } catch {
        // 見つからない候補は次へ進む。
      }
    }
  }
  return false;
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // chmod できない環境では書き込み成功を優先する。
  }
}

export function table(rows, headers) {
  const all = [headers, ...rows].map((row) => row.map((cell) => String(cell ?? '')));
  const widths = headers.map((_, column) => Math.max(...all.map((row) => row[column].length)));
  const format = (row) => row.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [format(headers), format(widths.map((w) => '-'.repeat(w))), ...rows.map(format)].join('\n');
}

export function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// config.argAliases に従って短縮フラグを実引数へ展開する。
// 表に無い引数はそのまま通す。`--` 以降は展開しない (claude へ素通しする領域のため)。
export function expandArgAliases(args = [], config = {}) {
  const aliases = config.argAliases || {};
  const out = [];
  let passthrough = false;
  for (const arg of args) {
    if (passthrough) {
      out.push(arg);
      continue;
    }
    if (arg === '--') {
      passthrough = true;
      out.push(arg);
      continue;
    }
    const replacement = Object.prototype.hasOwnProperty.call(aliases, arg) ? aliases[arg] : null;
    if (replacement == null) out.push(arg);
    else if (Array.isArray(replacement)) out.push(...replacement.map(String));
    else out.push(String(replacement));
  }
  return out;
}

export function projectKey(cwd) {
  return String(cwd || process.cwd()).replaceAll('/', '-').replaceAll('.', '-');
}
