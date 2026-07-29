import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './util.js';

const emptyState = {
  rateLimited: {},
  switches: [],
  lastSwitchBySession: {},
};

export function getPath() {
  const root = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(root, 'ccd', 'state.json');
}

export function loadState() {
  const stored = readJson(getPath()) || {};
  return {
    rateLimited: stored.rateLimited || {},
    switches: Array.isArray(stored.switches) ? stored.switches : [],
    lastSwitchBySession: stored.lastSwitchBySession || {},
    lastEvent: stored.lastEvent || null,
  };
}

export function saveState(state) {
  writeJsonAtomic(getPath(), pruneState(state));
}

export function recordRateLimit(name) {
  const state = loadState();
  state.rateLimited[name] = Date.now();
  saveState(state);
}

// StopFailure は stdout を捨てるため、フックが何をしたかは状態に残さないと後から追えない。
// `ccd hook status` がこれを表示する。
export function recordEvent(kind, message) {
  const state = loadState();
  state.lastEvent = { at: Date.now(), kind: String(kind), message: String(message) };
  saveState(state);
}

export function recordSwitch(entry) {
  const state = loadState();
  const at = entry.at || Date.now();
  state.switches.push({ at, fromName: entry.fromName, toName: entry.toName, sessionId: entry.sessionId || null });
  if (entry.sessionId) state.lastSwitchBySession[entry.sessionId] = at;
  saveState(state);
}

export function pruneState(state) {
  const now = Date.now();
  const out = {
    rateLimited: { ...(state.rateLimited || {}) },
    switches: Array.isArray(state.switches) ? state.switches.slice(-50) : [],
    lastSwitchBySession: { ...(state.lastSwitchBySession || {}) },
    lastEvent: state.lastEvent || null,
  };
  for (const [sessionId, at] of Object.entries(out.lastSwitchBySession)) {
    if (now - at > 24 * 60 * 60 * 1000) delete out.lastSwitchBySession[sessionId];
  }
  return out;
}

export function switchesInLastHour(state) {
  const since = Date.now() - 60 * 60 * 1000;
  return (state.switches || []).filter((entry) => Number(entry.at) >= since).length;
}
