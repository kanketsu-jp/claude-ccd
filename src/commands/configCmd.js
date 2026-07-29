import { spawnSync } from 'node:child_process';
import { getPath, loadConfig, saveConfig } from '../config.js';

function getValue(obj, key) {
  return String(key).split('.').reduce((current, part) => current?.[part], obj);
}

function setValue(obj, key, value) {
  const parts = String(key).split('.');
  let current = obj;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function run(args = []) {
  const action = args[0] || 'get';
  if (action === 'path') {
    process.stdout.write(getPath() + '\n');
    return 0;
  }
  if (action === 'get') {
    const config = loadConfig();
    const value = args[1] ? getValue(config, args[1]) : config;
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
    return 0;
  }
  if (action === 'set') {
    if (!args[1] || args.length < 3) {
      process.stderr.write('Usage: ccd config set <key> <value>\n');
      return 1;
    }
    const config = loadConfig();
    setValue(config, args[1], parseValue(args.slice(2).join(' ')));
    saveConfig(config);
    process.stdout.write('Updated config.\n');
    return 0;
  }
  if (action === 'edit') {
    saveConfig(loadConfig());
    const editor = process.env.EDITOR || 'vi';
    const result = spawnSync(editor, [getPath()], { stdio: 'inherit' });
    return typeof result.status === 'number' ? result.status : 1;
  }
  process.stderr.write('Usage: ccd config path|get [key]|set <key> <value>|edit\n');
  return 1;
}
