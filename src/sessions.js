import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { normalizeDir } from './accounts.js';

// Claude Code は cwd を「英数字以外をハイフンに置換」した名前で <config>/projects/ 配下に置く。
// ただしこの規則は Claude Code 側の実装詳細なので、推測名だけに頼ると規則が変わった時に
// 黙って「履歴なし」になる。推測名を先に試し、無ければ実物の transcript の cwd を読んで探す。
export function encodeProjectDirName(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// transcript は 1 行 1 JSON。cwd は先頭付近の行に入るので、頭だけ読んで判定する
// (履歴は 1 ファイル数 MB になるため全読みしない)。
export function readTranscriptCwd(file, maxBytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim() || !line.endsWith('}')) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.cwd === 'string' && parsed.cwd) return parsed.cwd;
      } catch {
        // 途中で切れた行は捨てて次を見る。
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // クローズ失敗は探索結果に影響しない。
      }
    }
  }
}

function transcriptFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// 指定 cwd の履歴ディレクトリを、その config dir の中から探す。
export function findProjectDir(configDir, cwd) {
  if (!configDir || !cwd) return null;
  const projects = path.join(normalizeDir(configDir), 'projects');
  const guess = path.join(projects, encodeProjectDirName(cwd));
  if (isDirectory(guess)) return guess;

  let entries = [];
  try {
    entries = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projects, entry.name);
    for (const file of transcriptFiles(dir).slice(0, 3)) {
      const found = readTranscriptCwd(path.join(dir, file));
      if (found === cwd) return dir;
      if (found) break; // cwd は読めたが別プロジェクト。このディレクトリは見切る。
    }
  }
  return null;
}

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function copyFileAtomic(source, target) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  fs.copyFileSync(source, tmp);
  fs.renameSync(tmp, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // chmod できない環境ではコピー成功を優先する。
  }
}

/**
 * 切替元の config dir から、切替先の config dir へ「今いる cwd の会話履歴」をコピーする。
 * 切替先で `claude --continue` / `--resume` が同じ会話を拾えるようにするのが目的。
 *
 * 失敗しても呼び出し側 (ccd use) を止めない前提なので、例外を投げずに理由を返す。
 * @returns {{status: string, copied: string[], skipped: string[], from: string|null, to: string|null}}
 */
export function copySessionHistory(fromDir, toDir, cwd, options = {}) {
  const { limit = 5, dryRun = false } = options;
  const result = { status: 'ok', copied: [], skipped: [], from: null, to: null };
  if (!fromDir || !toDir || !cwd) return { ...result, status: 'skipped-missing-args' };
  if (normalizeDir(fromDir) === normalizeDir(toDir)) return { ...result, status: 'skipped-same-account' };

  const source = findProjectDir(fromDir, cwd);
  if (!source) return { ...result, status: 'no-history' };
  result.from = source;

  const files = transcriptFiles(source)
    .map((name) => ({ name, mtime: mtimeMs(path.join(source, name)) }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => entry.name);
  const selected = Number.isFinite(limit) && limit > 0 ? files.slice(0, limit) : files;
  if (selected.length === 0) return { ...result, status: 'no-history' };

  // 切替先も同じ cwd から同じディレクトリ名を導くので、元のディレクトリ名をそのまま使う
  // (launcher.js の linkSessionHistory と同じ考え方)。
  const targetDir = path.join(normalizeDir(toDir), 'projects', path.basename(source));
  result.to = targetDir;
  try {
    if (!dryRun) fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { ...result, status: `error: ${error?.message || String(error)}` };
  }

  for (const name of selected) {
    const sourceFile = path.join(source, name);
    const targetFile = path.join(targetDir, name);
    // 既に同じか、より新しい履歴が置かれているなら上書きしない (切替先で進めた会話を潰さない)。
    if (fs.existsSync(targetFile) && mtimeMs(targetFile) >= mtimeMs(sourceFile)) {
      result.skipped.push(name);
      continue;
    }
    try {
      if (!dryRun) copyFileAtomic(sourceFile, targetFile);
      result.copied.push(name);
    } catch {
      result.skipped.push(name);
    }
  }
  return result;
}
