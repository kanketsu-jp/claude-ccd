import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './util.js';

const emptyState = {
  rateLimited: {},
  rateLimitedByEmail: {},
  switches: [],
  lastSwitchBySession: {},
  lastUsageFailover: null,
};

export function getPath() {
  const root = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(root, 'ccd', 'state.json');
}

export function loadState() {
  const stored = readJson(getPath()) || {};
  return {
    rateLimited: stored.rateLimited || {},
    rateLimitedByEmail: stored.rateLimitedByEmail || {},
    switches: Array.isArray(stored.switches) ? stored.switches : [],
    lastSwitchBySession: stored.lastSwitchBySession || {},
    lastEvent: stored.lastEvent || null,
    lastUsageFailover: stored.lastUsageFailover || null,
  };
}

export function saveState(state) {
  writeJsonAtomic(getPath(), pruneState(state));
}

export function recordRateLimit(accountOrName, email = null) {
  const state = loadState();
  const at = Date.now();
  const name = typeof accountOrName === 'string' ? accountOrName : accountOrName?.name;
  const address = (typeof accountOrName === 'string' ? email : accountOrName?.email) || null;
  if (name) state.rateLimited[name] = at;
  if (address) state.rateLimitedByEmail[String(address).toLowerCase()] = at;
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

export function recordUsageFailover(entry) {
  const state = loadState();
  state.lastUsageFailover = {
    account: String(entry.account),
    resetsAt: Number(entry.resetsAt || 0) || null,
    at: entry.at || Date.now(),
  };
  saveState(state);
}

export function pruneState(state) {
  const now = Date.now();
  const out = {
    rateLimited: { ...(state.rateLimited || {}) },
    rateLimitedByEmail: { ...(state.rateLimitedByEmail || {}) },
    switches: Array.isArray(state.switches) ? state.switches.slice(-50) : [],
    lastSwitchBySession: { ...(state.lastSwitchBySession || {}) },
    lastEvent: state.lastEvent || null,
  };
  if (state.lastUsageFailover) out.lastUsageFailover = state.lastUsageFailover;
  for (const [sessionId, at] of Object.entries(out.lastSwitchBySession)) {
    if (now - at > 24 * 60 * 60 * 1000) delete out.lastSwitchBySession[sessionId];
  }
  return out;
}

export function switchesInLastHour(state) {
  const since = Date.now() - 60 * 60 * 1000;
  return (state.switches || []).filter((entry) => Number(entry.at) >= since).length;
}
