import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deepMerge, readJson, writeJsonAtomic } from './util.js';

export const defaultConfig = {
  claudeBin: null,
  launchArgs: [],
  preferredAccount: null,
  // 短縮フラグ -> 実引数の展開表。例: {"-y": ["--dangerously-skip-permissions"]}
  argAliases: {},
  extraDirs: [],
  // `ccd use` で切り替えるとき、今いる cwd の会話履歴を切替元から切替先へコピーする設定。
  // limit は「新しい順に何本コピーするか」(0 以下ですべて)。
  copySessions: {
    enabled: true,
    limit: 5,
  },
  autoSwitch: {
    mode: 'notify',
    updateDefault: true,
    cooldownMinutes: 60,
    minIntervalMinutes: 5,
    maxSwitchesPerHour: 4,
    resume: true,
    continueMessage: 'continue',
    order: [],
    launcher: 'auto',
  },
};

export function getPath() {
  const root = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(root, 'ccd', 'config.json');
}

export function loadConfig() {
  const file = getPath();
  const stored = fs.existsSync(file) ? readJson(file) : null;
  return deepMerge(defaultConfig, stored || {});
}

export function saveConfig(obj) {
  writeJsonAtomic(getPath(), deepMerge(defaultConfig, obj || {}));
}
