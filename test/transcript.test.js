import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findTranscript, linkSessionHistory } from '../src/launcher.js';

const SESSION = 'cb15151d-9fd0-48a8-8c61-34b756b2fba4';

function makeAccounts(projectDirName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-transcript-'));
  const from = { name: 'from', dir: path.join(root, 'from'), isDefault: false };
  const to = { name: 'to', dir: path.join(root, 'to'), isDefault: false };
  const sourceDir = path.join(from.dir, 'projects', projectDirName);
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(to.dir, { recursive: true });
  const source = path.join(sourceDir, `${SESSION}.jsonl`);
  fs.writeFileSync(source, '{"type":"user"}\n');
  return { from, to, source, projectDirName };
}

test('findTranscript locates a session without reimplementing the directory naming', () => {
  // ディレクトリ名は cwd から機械的に導かれるが、その規則を推測すると
  // スペースや記号を含むパスで食い違う。実物を探すので規則を知る必要がない。
  const { from, source } = makeAccounts('-Users-you-My-Project-v2');
  assert.equal(findTranscript(from, SESSION), source);
});

test('findTranscript prefers the transcript path handed over by the hook', () => {
  const { from, source } = makeAccounts('-anything');
  assert.equal(findTranscript(from, SESSION, source), source);
});

test('findTranscript ignores a transcript path that no longer exists', () => {
  const { from, source } = makeAccounts('-Users-you-project');
  assert.equal(findTranscript(from, SESSION, '/nope/missing.jsonl'), source);
});

test('findTranscript returns null when the session is not there', () => {
  const { from } = makeAccounts('-Users-you-project');
  assert.equal(findTranscript(from, 'no-such-session'), null);
  assert.equal(findTranscript(from, null), null);
});

test('linkSessionHistory reuses the source directory name in the target account', () => {
  // 切り替え先も同じ cwd から同じ名前を導くので、名前をそのまま持ち込めば一致する。
  const { from, to, source, projectDirName } = makeAccounts('-Users-you-My-Project-v2');
  assert.equal(linkSessionHistory(from, to, SESSION), true);
  const linked = path.join(to.dir, 'projects', projectDirName, `${SESSION}.jsonl`);
  assert.equal(fs.realpathSync(linked), fs.realpathSync(source));
});

test('linkSessionHistory shares only the requested session, not the whole history', () => {
  // 履歴ディレクトリごと共有すると 2 つのアカウントの会話が混ざる。
  const { from, to, projectDirName } = makeAccounts('-Users-you-project');
  fs.writeFileSync(path.join(from.dir, 'projects', projectDirName, 'other-session.jsonl'), '{}\n');
  linkSessionHistory(from, to, SESSION);
  const copied = fs.readdirSync(path.join(to.dir, 'projects', projectDirName));
  assert.deepEqual(copied, [`${SESSION}.jsonl`]);
});

test('linkSessionHistory is idempotent and fails softly', () => {
  const { from, to } = makeAccounts('-Users-you-project');
  assert.equal(linkSessionHistory(from, to, SESSION), true);
  assert.equal(linkSessionHistory(from, to, SESSION), true);
  assert.equal(linkSessionHistory(from, to, 'missing-session'), false);
});
