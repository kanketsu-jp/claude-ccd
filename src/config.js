import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deepMerge, readJson, writeJsonAtomic } from './util.js';

export const defaultConfig = {
  claudeBin: null,
  launchArgs: [],
  extraDirs: [],
  autoSwitch: {
    mode: 'notify',
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
