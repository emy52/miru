import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

let blocker = null;

/**
 * Network-level blocking (EasyList + EasyPrivacy + uBO). Kills banner/overlay/
 * tracking requests outright.
 *
 * Cosmetic filters and scriptlets are deliberately OFF: YouTube's CSP + trusted
 * types reject the injected scripts, so every navigation threw an unhandled
 * "Script failed to execute". src/inject/*.css covers the same ground for us.
 *
 * This does NOT kill in-stream video ads either — those come from the same
 * googlevideo.com hosts as the video, so there is no distinct request to block.
 * killAds() in preload/youtube.cjs handles those in the page.
 */
const ENGINE_CONFIG = {
  loadCosmeticFilters: false,
  loadGenericCosmeticsFilters: false,
  loadExtendedSelectors: false,
  enableHtmlFiltering: false,
  loadNetworkFilters: true,
  loadCSPFilters: true,
  enableOptimizations: true,
};

export async function attachAdblock(session) {
  const { ElectronBlocker, adsAndTrackingLists } = await import('@ghostery/adblocker-electron');
  const cachePath = path.join(app.getPath('userData'), 'adblock-engine.bin');
  const caching = {
    path: cachePath,
    read: fs.promises.readFile,
    write: fs.promises.writeFile,
  };

  try {
    blocker = await ElectronBlocker.fromLists(fetch, adsAndTrackingLists, ENGINE_CONFIG, caching);
    console.log('[adblock] engine ready (network filters only)');
  } catch (err) {
    console.warn(`[adblock] could not build engine (${err.message}); trying cache only`);
    try {
      blocker = await ElectronBlocker.deserialize(await fs.promises.readFile(cachePath));
      console.log('[adblock] engine restored from cache');
    } catch {
      console.warn('[adblock] running without network blocking this session');
      return null;
    }
  }

  blocker.enableBlockingInSession(session);
  return blocker;
}

export function setAdblockEnabled(session, enabled) {
  if (!blocker) return false;
  if (enabled) blocker.enableBlockingInSession(session);
  else blocker.disableBlockingInSession(session);
  return true;
}
