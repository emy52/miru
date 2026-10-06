import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');

const userDir = () => app.getPath('userData');

export const paths = {
  root: ROOT,
  inject: path.join(ROOT, 'src', 'inject'),
  defaultFilters: path.join(ROOT, 'config', 'filters.default.json'),
  get userFilters() { return path.join(userDir(), 'filters.json'); },
  get settings() { return path.join(userDir(), 'settings.json'); },
  get verdictCache() { return path.join(userDir(), 'verdicts.json'); },
  get channelMap() { return path.join(userDir(), 'channels.json'); },
};

export const DEFAULT_SETTINGS = {
  sponsorSkip: true,
  focus: false,
  adblock: true,
  hideShorts: true,
  sidebarCollapsed: false,
  window: { width: 1420, height: 900 },
  llm: {
    enabled: false,
    endpoint: 'http://127.0.0.1:8080/v1/chat/completions',
    model: 'local',
    timeoutMs: 12000,
    maxConcurrent: 2,
  },
};

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[store] bad JSON in ${file}: ${err.message}`);
    return fallback;
  }
}

function writeJSON(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn(`[store] could not write ${file}: ${err.message}`);
  }
}

// Shallow-merge one level deep so a partial settings.json still gets new defaults.
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object'
      ? { ...base[k], ...v }
      : v;
  }
  return out;
}

let settings = null;

export function getSettings() {
  if (!settings) settings = merge(DEFAULT_SETTINGS, readJSON(paths.settings, {}));
  return settings;
}

export function setSettings(patch) {
  settings = merge(getSettings(), patch);
  writeJSON(paths.settings, settings);
  return settings;
}

/**
 * Rules = shipped defaults, overlaid with the user's filters.json if present.
 * Word/channel lists in the user file are merged additively (so you extend the
 * defaults rather than having to restate them); scalars are replaced.
 */
export function getRules() {
  const base = readJSON(paths.defaultFilters, { categories: {}, focus: {}, channels: {}, rescue: {} });
  const user = readJSON(paths.userFilters, null);
  if (!user) {
    base.channelReputation = getChannelMap();
    return base;
  }

  const rules = merge(base, user);
  rules.categories = { ...base.categories };
  for (const [name, def] of Object.entries(user.categories || {})) {
    const b = base.categories[name] || {};
    rules.categories[name] = {
      ...b,
      ...def,
      words: [...(b.words || []), ...(def.words || [])],
      patterns: [...(b.patterns || []), ...(def.patterns || [])],
      channelWords: [...(b.channelWords || []), ...(def.channelWords || [])],
    };
  }
  rules.channels = {
    block: [...(base.channels?.block || []), ...(user.channels?.block || [])],
    allow: [...(base.channels?.allow || []), ...(user.channels?.allow || [])],
  };
  rules.channelReputation = getChannelMap();
  return rules;
}

/**
 * Channel reputation: keyword lists can never enumerate every gaming or comedy
 * channel, so we learn them. Each video a channel posts that the keywords
 * confidently categorise is one vote; past `channelMinVotes` the channel itself
 * counts as evidence, which is what catches its keyword-free uploads.
 *
 * ~/.config/miru/channels.json is plain JSON — editable and deletable by hand if
 * the filter learns something wrong.
 */
let channelMap = null;
let channelMapDirty = false;

export function getChannelMap() {
  if (!channelMap) channelMap = readJSON(paths.channelMap, {});
  return channelMap;
}

export function learnChannel(name, category) {
  const key = String(name || '').trim().toLowerCase();
  if (!key || !category) return false;
  const map = getChannelMap();
  const entry = map[key] || (map[key] = {});
  if ((entry[category] || 0) >= 99) return false; // saturated; stop churning the file
  entry[category] = (entry[category] || 0) + 1;
  channelMapDirty = true;
  return true;
}

/** Record YouTube's own category label for a channel (looked up once, cached). */
export function setChannelYT(name, ytCategory) {
  const key = String(name || '').trim().toLowerCase();
  if (!key || !ytCategory) return false;
  const map = getChannelMap();
  const entry = map[key] || (map[key] = {});
  if (entry.yt === ytCategory) return false;
  entry.yt = ytCategory;
  channelMapDirty = true;
  return true;
}

export function flushChannelMap() {
  if (!channelMapDirty) return;
  writeJSON(paths.channelMap, getChannelMap());
  channelMapDirty = false;
}

export function blockChannel(name) {
  const user = readJSON(paths.userFilters, {});
  user.channels = user.channels || { block: [], allow: [] };
  user.channels.block = user.channels.block || [];
  const key = String(name || '').trim();
  if (key && !user.channels.block.some((c) => c.toLowerCase() === key.toLowerCase())) {
    user.channels.block.push(key);
    writeJSON(paths.userFilters, user);
  }
  return getRules();
}

// ---- verdict cache (title -> category), persisted so the LLM only ever sees a title once
let cache = null;
let cacheDirty = false;

export function getCache() {
  if (!cache) cache = readJSON(paths.verdictCache, {});
  return cache;
}

export function cacheGet(key) {
  return getCache()[key];
}

export function cacheSet(key, value) {
  getCache()[key] = value;
  cacheDirty = true;
}

export function flushCache() {
  if (!cacheDirty) return;
  writeJSON(paths.verdictCache, getCache());
  cacheDirty = false;
}

setInterval(() => { flushCache(); flushChannelMap(); }, 30_000).unref?.();
