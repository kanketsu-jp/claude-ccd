import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copySessionHistory, encodeProjectDirName, findProjectDir, readTranscriptCwd } from '../src/sessions.js';

function tmpdir() {
  // macOS の $TMPDIR は symlink (/var → /private/var) なので、実パスに揃えないと
  // cwd 比較が偽陰性になる。
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-sessions-')));
}

function writeTranscript(dir, name, cwd, extraLines = 0) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: 'user', cwd, sessionId: name.replace('.jsonl', '') })];
  for (let i = 0; i < extraLines; i += 1) lines.push(JSON.stringify({ type: 'assistant', text: 'x'.repeat(64) }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('encodeProjectDirName mirrors the Claude Code projects/ naming', () => {
  assert.equal(encodeProjectDirName('/Users/me/Develop/Projects/cc'), '-Users-me-Develop-Projects-cc');
  assert.equal(encodeProjectDirName('/Users/me/.claude'), '-Users-me--claude');
});

test('readTranscriptCwd reads cwd from the first usable line', () => {
  const home = tmpdir();
  const file = writeTranscript(path.join(home, 'p'), 'a.jsonl', '/work/here');
  assert.equal(readTranscriptCwd(file), '/work/here');
});

test('findProjectDir finds the directory by encoded name', () => {
  const home = tmpdir();
  const cwd = '/work/proj';
  const dir = path.join(home, '.claude', 'projects', encodeProjectDirName(cwd));
  writeTranscript(dir, 'a.jsonl', cwd);
  assert.equal(findProjectDir(path.join(home, '.claude'), cwd), dir);
});

test('findProjectDir falls back to reading transcripts when the name does not match', () => {
  // Claude Code 側の命名規則が変わっても「履歴なし」と黙って返さないこと。
  const home = tmpdir();
  const cwd = '/work/proj';
  const dir = path.join(home, '.claude', 'projects', 'some-unexpected-name-9f2a');
  writeTranscript(dir, 'a.jsonl', cwd);
  writeTranscript(path.join(home, '.claude', 'projects', 'other'), 'b.jsonl', '/work/elsewhere');
  assert.equal(findProjectDir(path.join(home, '.claude'), cwd), dir);
});

test('findProjectDir returns null when no history matches the cwd', () => {
  const home = tmpdir();
  writeTranscript(path.join(home, '.claude', 'projects', 'other'), 'b.jsonl', '/work/elsewhere');
  assert.equal(findProjectDir(path.join(home, '.claude'), '/work/proj'), null);
});

test('copySessionHistory copies the newest transcripts into the target account', () => {
  const home = tmpdir();
  const cwd = '/work/proj';
  const from = path.join(home, '.claude');
  const to = path.join(home, '.claude-work');
  const sourceDir = path.join(from, 'projects', encodeProjectDirName(cwd));
  const older = writeTranscript(sourceDir, 'older.jsonl', cwd);
  const newer = writeTranscript(sourceDir, 'newer.jsonl', cwd);
  fs.utimesSync(older, new Date(1000), new Date(1000));
  fs.utimesSync(newer, new Date(2000), new Date(2000));

  const result = copySessionHistory(from, to, cwd, { limit: 1 });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.copied, ['newer.jsonl']);
  const target = path.join(to, 'projects', encodeProjectDirName(cwd));
  assert.ok(fs.existsSync(path.join(target, 'newer.jsonl')));
  assert.equal(fs.existsSync(path.join(target, 'older.jsonl')), false, 'limit を超えた履歴までコピーしてはいけない');
});

test('copySessionHistory with limit 0 copies every transcript', () => {
  const home = tmpdir();
  const cwd = '/work/proj';
  const from = path.join(home, '.claude');
  const to = path.join(home, '.claude-work');
  const sourceDir = path.join(from, 'projects', encodeProjectDirName(cwd));
  writeTranscript(sourceDir, 'a.jsonl', cwd);
  writeTranscript(sourceDir, 'b.jsonl', cwd);
  const result = copySessionHistory(from, to, cwd, { limit: 0 });
  assert.equal(result.copied.length, 2);
});

test('copySessionHistory keeps the transcript with the newer mtime', () => {
  // 切替先で会話を進めた後にもう一度 use しても、更新時刻の新しい履歴を巻き戻さないこと。
  const home = tmpdir();
  const cwd = '/work/proj';
  const from = path.join(home, '.claude');
  const to = path.join(home, '.claude-work');
  const sourceFile = writeTranscript(path.join(from, 'projects', encodeProjectDirName(cwd)), 'a.jsonl', cwd, 50);
  const targetFile = writeTranscript(path.join(to, 'projects', encodeProjectDirName(cwd)), 'a.jsonl', cwd, 1);
  fs.utimesSync(sourceFile, new Date(1000), new Date(1000));
  fs.utimesSync(targetFile, new Date(2000), new Date(2000));
  const before = fs.readFileSync(targetFile, 'utf8');

  const result = copySessionHistory(from, to, cwd, { limit: 5 });
  assert.deepEqual(result.copied, []);
  assert.deepEqual(result.skipped, ['a.jsonl']);
  assert.equal(fs.readFileSync(targetFile, 'utf8'), before);
});

test('copySessionHistory refuses to copy an account onto itself', () => {
  const home = tmpdir();
  const from = path.join(home, '.claude');
  writeTranscript(path.join(from, 'projects', encodeProjectDirName('/work/proj')), 'a.jsonl', '/work/proj');
  assert.equal(copySessionHistory(from, from, '/work/proj', {}).status, 'skipped-same-account');
});

test('copySessionHistory reports no-history instead of throwing', () => {
  const home = tmpdir();
  const result = copySessionHistory(path.join(home, '.claude'), path.join(home, '.claude-work'), '/work/proj', {});
  assert.equal(result.status, 'no-history');
  assert.deepEqual(result.copied, []);
});

test('copySessionHistory dry run copies nothing', () => {
  const home = tmpdir();
  const cwd = '/work/proj';
  const from = path.join(home, '.claude');
  const to = path.join(home, '.claude-work');
  writeTranscript(path.join(from, 'projects', encodeProjectDirName(cwd)), 'a.jsonl', cwd);
  const result = copySessionHistory(from, to, cwd, { dryRun: true });
  assert.deepEqual(result.copied, ['a.jsonl']);
  assert.equal(fs.existsSync(path.join(to, 'projects')), false);
});
