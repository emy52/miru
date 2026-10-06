import { app, BrowserWindow, WebContentsView, ipcMain, session, shell, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { attachAdblock, setAdblockEnabled } from './adblock.js';
import { getRules, getSettings, setSettings, blockChannel, flushCache, learnChannel, setChannelYT, flushChannelMap } from './store.js';
import { resolveUnknown, probeLLM } from './classifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// These MUST match --chrome-h / --rail-w / --rail-w-min in src/renderer/shell.css.
// The renderer draws the sidebar; main positions the YouTube view beside it. If
// they drift, YouTube slides under the sidebar edge or leaves a gap.
const CHROME_H = 72;   // --chrome-h
const RAIL_W = 232;    // --rail-w
const RAIL_W_MIN = 76; // --rail-w-min
const TEST_WINDOW = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.MIRU_TEST_WINDOW || '');

const YT_PARTITION = 'persist:youtube';
const HOME = 'https://www.youtube.com/';

// Present as a normal browser on the current OS. Google refuses sign-in to UAs
// it reads as embedded, and a Linux UA in a Windows build is needlessly odd.
const UA_PLATFORM = {
  win32: 'Windows NT 10.0; Win64; x64',
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  linux: 'X11; Linux x86_64',
}[process.platform] || 'X11; Linux x86_64';
const CHROME_UA = `Mozilla/5.0 (${UA_PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;
const FIREFOX_UA = `Mozilla/5.0 (${UA_PLATFORM}; rv:133.0) Gecko/20100101 Firefox/133.0`;

app.setName('miru');
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations,VaapiVideoDecodeLinuxGL');
}

let win = null;
let yt = null;
// Window-manager fullscreen and a video's HTML fullscreen are different modes.
// The former keeps miru's chrome; the latter temporarily gives the player the
// whole window. Keeping this state independent of BrowserWindow.isFullScreen()
// prevents Super+F from being mistaken for a player request.
let videoFullscreen = false;
let windowWasFullscreenBeforeVideo = false;

function layout() {
  if (!win || !yt) return;
  const liveBounds = win.getContentBounds();
  // Wayland can force the shell window to monitor size in headless QA. The
  // child view still accepts exact bounds, so its responsive CSS remains testable.
  const width = TEST_WINDOW ? Number(TEST_WINDOW[1]) : liveBounds.width;
  const height = TEST_WINDOW ? Number(TEST_WINDOW[2]) : liveBounds.height;
  if (videoFullscreen) {
    yt.setBounds({ x: 0, y: 0, width, height });
    return;
  }
  const rail = getSettings().sidebarCollapsed ? RAIL_W_MIN : RAIL_W;
  yt.setBounds({
    x: rail,
    y: CHROME_H,
    width: Math.max(0, width - rail),
    height: Math.max(0, height - CHROME_H),
  });
}

const toShellWatch = (url) => {
  // /shorts/<id> is the same video as /watch?v=<id> — swap it and you get a
  // normal player with a scrubber instead of the swipe feed.
  const m = /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/([\w-]+)/.exec(url || '');
  return m ? `https://www.youtube.com/watch?v=${m[1]}` : null;
};

const isWatchPage = (url) => {
  try {
    const page = new URL(url);
    return page.hostname !== 'music.youtube.com'
      && /(^|\.)youtube\.com$/.test(page.hostname)
      && page.pathname === '/watch';
  } catch {
    return false;
  }
};

function pushNavState() {
  if (!win || win.isDestroyed() || !yt) return;
  const wc = yt.webContents;
  win.webContents.send('yt:nav-state', {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
  });
}

async function createWindow() {
  const settings = getSettings();
  nativeTheme.themeSource = 'dark';

  win = new BrowserWindow({
    width: TEST_WINDOW ? Number(TEST_WINDOW[1]) : settings.window.width,
    height: TEST_WINDOW ? Number(TEST_WINDOW[2]) : settings.window.height,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#02030a', // must match --void in shell.css or the window flashes
    titleBarStyle: 'hidden',
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'shell.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => {
    // Visual QA hook: some Wayland compositors maximize a fresh frameless
    // window. Reasserting bounds here makes minimum-size screenshots truthful.
    if (TEST_WINDOW) {
      win.unmaximize();
      win.setBounds({ width: Number(TEST_WINDOW[1]), height: Number(TEST_WINDOW[2]) });
    }
    win.show();
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

  const ytSession = session.fromPartition(YT_PARTITION);
  ytSession.setUserAgent(CHROME_UA);

  // Google blocks sign-in from anything it reads as an embedded browser. Its
  // check is partly UA-driven, so present Firefox on the accounts host only.
  // This is a long shot, not a guarantee — see HANDOFF.md "sign-in".
  ytSession.webRequest.onBeforeSendHeaders({ urls: ['*://accounts.google.com/*'] }, (details, cb) => {
    cb({ requestHeaders: { ...details.requestHeaders, 'User-Agent': FIREFOX_UA } });
  });
  if (settings.adblock) await attachAdblock(ytSession);

  yt = new WebContentsView({
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'youtube.cjs'),
      partition: YT_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.contentView.addChildView(yt);
  yt.webContents.setUserAgent(CHROME_UA);
  layout();

  const wc = yt.webContents;
  wc.setMaxListeners(40); // adblocker + our own nav listeners exceed the default 10

  // Only an actual watch-page player may take over miru's chrome. BrowserWindow
  // fullscreen (for example Super+F) remains a normal, chrome-bearing layout.
  wc.on('enter-html-full-screen', () => {
    if (!win || !isWatchPage(wc.getURL())) {
      layout();
      return;
    }
    windowWasFullscreenBeforeVideo = win.isFullScreen();
    videoFullscreen = true;
    send('win:video-fullscreen', { fullscreen: true });
    layout();
    if (!windowWasFullscreenBeforeVideo) win.setFullScreen(true);
  });
  wc.on('leave-html-full-screen', () => {
    if (!win || !videoFullscreen) return;
    const restoreWindowed = !windowWasFullscreenBeforeVideo;
    videoFullscreen = false;
    windowWasFullscreenBeforeVideo = false;
    send('win:video-fullscreen', { fullscreen: false });
    layout();
    if (restoreWindowed && win.isFullScreen()) win.setFullScreen(false);
  });

  wc.on('will-navigate', (e, url) => {
    const watch = toShellWatch(url);
    if (watch) {
      e.preventDefault();
      wc.loadURL(watch);
    }
  });

  wc.setWindowOpenHandler(({ url }) => {
    const watch = toShellWatch(url);
    if (watch) {
      wc.loadURL(watch);
      return { action: 'deny' };
    }
    if (/^https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\//.test(url)) {
      wc.loadURL(url);
      return { action: 'deny' };
    }
    shell.openExternal(url); // anything off-site goes to the real browser
    return { action: 'deny' };
  });

  for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) {
    wc.on(ev, pushNavState);
  }

  wc.on('did-finish-load', () => win?.webContents.send('yt:stats', { reset: true }));

  wc.loadURL(HOME);

  win.on('resize', layout);
  win.on('enter-full-screen', layout);
  win.on('leave-full-screen', () => {
    // Some window managers can leave fullscreen directly while the page is
    // still unwinding its HTML fullscreen state. Restore chrome immediately.
    if (videoFullscreen) {
      videoFullscreen = false;
      windowWasFullscreenBeforeVideo = false;
      send('win:video-fullscreen', { fullscreen: false });
    }
    layout();
  });
  win.on('maximize', () => { layout(); win.webContents.send('win:state', { maximized: true }); });
  win.on('unmaximize', () => { layout(); win.webContents.send('win:state', { maximized: false }); });

  if (!win.isVisible()) win.show(); // belt and braces if ready-to-show already fired

  if (process.argv.includes('--shot')) captureAndQuit();
  if (process.argv.includes('--selftest')) selfTest();
  const importIdx = process.argv.indexOf('--import-session');
  if (importIdx !== -1) importSession(process.argv[importIdx + 1]);

  win.on('close', () => {
    if (!win.isMaximized()) {
      const [width, height] = win.getSize();
      setSettings({ window: { width, height } });
    }
    flushCache();
    flushChannelMap();
  });
  win.on('closed', () => {
    win = null;
    yt = null;
    videoFullscreen = false;
    windowWasFullscreenBeforeVideo = false;
  });
}

// ---------------------------------------------------------------- IPC

const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };

ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
ipcMain.on('win:close', () => win?.close());

ipcMain.on('yt:go', (_e, target) => {
  if (!yt) return;
  const wc = yt.webContents;
  if (target === 'back' && wc.navigationHistory.canGoBack()) return wc.navigationHistory.goBack();
  if (target === 'forward' && wc.navigationHistory.canGoForward()) return wc.navigationHistory.goForward();
  if (target === 'reload') return wc.reload();
  if (typeof target !== 'string') return;
  if (target.startsWith('/')) return wc.loadURL(`https://www.youtube.com${target}`);
  // Full URLs are used for sibling properties (music.youtube.com); keep them in-app.
  if (/^https:\/\/(?:www\.|music\.)?youtube\.com\//.test(target)) return wc.loadURL(target);
});

ipcMain.on('yt:search', (_e, q) => {
  const query = String(q || '').trim();
  if (query && yt) yt.webContents.loadURL(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`);
});

ipcMain.handle('settings:get', () => ({ settings: getSettings(), rules: getRules() }));

ipcMain.handle('settings:set', async (_e, patch) => {
  const before = getSettings();
  const next = setSettings(patch);
  if (patch.adblock !== undefined && patch.adblock !== before.adblock) {
    setAdblockEnabled(session.fromPartition(YT_PARTITION), next.adblock);
  }
  if (patch.sidebarCollapsed !== undefined) layout();
  // Both surfaces need to know: the sidebar redraws, the page re-filters.
  send('settings:changed', next);
  yt?.webContents.send('settings:changed', { settings: next, rules: getRules() });
  return next;
});

ipcMain.handle('filter:context', () => ({ settings: getSettings(), rules: getRules() }));
ipcMain.handle('filter:resolve', async (_e, videos) => resolveUnknown(videos || []));

ipcMain.handle('filter:block-channel', (_e, name) => {
  const rules = blockChannel(name);
  yt?.webContents.send('settings:changed', { settings: getSettings(), rules });
  return rules;
});

// The page reports channels whose videos the keyword tiers positively identified.
// Once a channel is established, its keyword-free uploads get caught too — the
// whole point, since no word list can enumerate every gaming or comedy channel.
let rulesPushTimer = null;
ipcMain.on('filter:learn', (_e, items) => {
  let changed = false;
  for (const item of items || []) {
    if (learnChannel(item?.channel, item?.category)) changed = true;
  }
  if (!changed) return;
  // Coalesce: a busy feed reports many votes at once, and re-pushing rules
  // re-runs the whole scan.
  clearTimeout(rulesPushTimer);
  rulesPushTimer = setTimeout(() => {
    yt?.webContents.send('filter:rules', getRules());
  }, 1500);
});

// ---- "what is this channel known for": ask YouTube.
//
// Every video carries YouTube's own category (Gaming, Comedy, Music, Education…)
// in its watch-page microformat. Keyword lists can't enumerate channels, but this
// is authoritative — so we look it up ONCE per channel and cache it forever in
// channels.json. A feed of ~20 channels costs ~20 requests, once, ever.
const identifyQueue = [];
const identifyTried = new Set(); // don't retry a channel within this session
let identifyActive = 0;
const IDENTIFY_MAX = 3;

async function identifyOne(channel, videoId) {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  try {
    // Fetch inside the youtube partition so it carries our cookies and UA and
    // doesn't trip a consent wall.
    const res = await session.fromPartition(YT_PARTITION).fetch(url);
    if (!res.ok) return false;
    const html = await res.text();
    const m = /"category"\s*:\s*"([^"]{2,40})"/.exec(html);
    if (!m) return false;
    const label = m[1].replace(/\\u0026/g, '&');
    return setChannelYT(channel, label);
  } catch {
    return false; // offline, rate-limited, layout changed — try again next session
  }
}

function pumpIdentify() {
  while (identifyActive < IDENTIFY_MAX && identifyQueue.length) {
    const { channel, videoId } = identifyQueue.shift();
    identifyActive += 1;
    identifyOne(channel, videoId)
      .then((changed) => {
        if (changed) {
          clearTimeout(rulesPushTimer);
          rulesPushTimer = setTimeout(() => yt?.webContents.send('filter:rules', getRules()), 1500);
        }
      })
      .finally(() => { identifyActive -= 1; pumpIdentify(); });
  }
}

ipcMain.on('filter:identify', (_e, items) => {
  for (const item of items || []) {
    const channel = String(item?.channel || '').trim().toLowerCase();
    if (!channel || !item?.videoId || identifyTried.has(channel)) continue;
    identifyTried.add(channel);
    identifyQueue.push({ channel, videoId: item.videoId });
  }
  pumpIdentify();
});

// ---- SponsorBlock: mid-video sponsors and promotions only (see HANDOFF.md).
// Uses the hash-prefix endpoint so the full video id never leaves the machine.
const SB_CATEGORIES = ['sponsor', 'selfpromo'];
const sbCache = new Map();
ipcMain.handle('sb:segments', async (_e, videoId) => {
  if (!/^[\w-]{11}$/.test(String(videoId))) return [];
  if (sbCache.has(videoId)) return sbCache.get(videoId);
  try {
    const { createHash } = await import('node:crypto');
    const prefix = createHash('sha256').update(videoId).digest('hex').slice(0, 4);
    const url = `https://sponsor.ajay.app/api/skipSegments/${prefix}?categories=${encodeURIComponent(JSON.stringify(SB_CATEGORIES))}&actionTypes=${encodeURIComponent('["skip"]')}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    let segments = [];
    if (res.ok) {
      const hit = (await res.json()).find((v) => v.videoID === videoId);
      segments = (hit?.segments || [])
        .filter((x) => SB_CATEGORIES.includes(x.category) && x.actionType === 'skip' && x.segment?.[1] - x.segment?.[0] >= 1)
        .map((x) => ({ start: x.segment[0], end: x.segment[1], category: x.category }));
    } else if (res.status !== 404) return []; // transient error: don't cache
    sbCache.set(videoId, segments);
    return segments;
  } catch { return []; }
});

ipcMain.on('yt:stats', (_e, stats) => send('yt:stats', stats));
ipcMain.handle('llm:probe', () => probeLLM());
ipcMain.handle('login:start', () => loginWithBrowser());

// ---------------------------------------------------------------- lifecycle

/**
 * --shot: dev helper. Captures the app chrome and the YouTube view separately
 * (WebContentsView children aren't included in the window's own capturePage)
 * and writes both, then quits. Never captures anything outside this app.
 */
async function captureAndQuit() {
  const outDir = process.env.MIRU_SHOT_DIR || '/tmp';
  const wait = Number(process.env.MIRU_SHOT_WAIT || 9000);
  if (process.env.MIRU_SHOT_URL) yt.webContents.loadURL(process.env.MIRU_SHOT_URL);
  setTimeout(async () => {
    try {
      const fsp = await import('node:fs/promises');
      const chrome = await win.webContents.capturePage();
      await fsp.writeFile(path.join(outDir, 'miru-chrome.png'), chrome.toPNG());
      if (process.env.MIRU_SHOT_EVAL) {
        const out = await yt.webContents.executeJavaScript(process.env.MIRU_SHOT_EVAL);
        console.log('[shot] eval', typeof out === 'string' ? out : JSON.stringify(out, null, 1));
        await new Promise((r) => setTimeout(r, 1200));
      }
      const page = await yt.webContents.capturePage();
      await fsp.writeFile(path.join(outDir, 'miru-page.png'), page.toPNG());
      console.log(`[shot] wrote miru-chrome.png + miru-page.png to ${outDir}`);
    } catch (err) {
      console.error('[shot] failed:', err.message);
    }
    app.quit();
  }, wait);
}

/**
 * --selftest: reports whether the injection pipeline actually took effect on the
 * live page. Text only — deliberately never captures the page, which can show
 * account content.
 */
function selfTest() {
  const wait = Number(process.env.MIRU_TEST_WAIT || 12000);
  if (process.env.MIRU_TEST_FOCUS === '1') setSettings({ focus: true });
  yt.webContents.loadURL(process.env.MIRU_TEST_URL || HOME);
  setTimeout(async () => {
    try {
      const probe = `(() => {
        const cs = getComputedStyle(document.documentElement);
        const q = (s) => document.querySelectorAll(s).length;
        const masthead = document.querySelector('#masthead-container, ytd-masthead');
        return {
          url: location.href,
          themeApplied: cs.getPropertyValue('--miru-bg').trim() !== '',
          focusAttr: document.documentElement.dataset.miruFocus || null,
          bgToken: cs.getPropertyValue('--yt-spec-base-background').trim(),
          bodyBg: getComputedStyle(document.body).backgroundColor,
          mastheadHidden: masthead ? getComputedStyle(masthead).display === 'none' : 'no-masthead',
          cards: q('ytd-rich-item-renderer,ytd-video-renderer,ytd-compact-video-renderer,yt-lockup-view-model'),
          hidden: q('[data-miru-hidden]'),
          blockBtns: q('.miru-block'),
          shortsLinks: q('a[href^="/shorts"]'),
          chipBar: {
            scrollY: Math.round(window.scrollY),
            nodes: [...document.querySelectorAll('ytd-feed-filter-chip-bar-renderer, #chips-wrapper, yt-chip-cloud-renderer')].slice(0, 8).map((el) => {
              const style = getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return {
                node: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
                display: style.display,
                position: style.position,
                top: Math.round(rect.top),
                height: Math.round(rect.height),
                background: style.backgroundColor,
                text: (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 90),
              };
            }),
          },
          hero: (() => {
            const h = document.querySelector('.miru-hero');
            if (!h) {
              const first = document.querySelector('ytd-rich-item-renderer:not([data-miru-hidden])');
              return {
                built: false,
                pathname: location.pathname,
                gridFound: !!document.querySelector('ytd-rich-grid-renderer'),
                richItems: document.querySelectorAll('ytd-rich-item-renderer').length,
                firstCardAnchors: first
                  ? [...first.querySelectorAll('a[href]')].slice(0, 4).map((a) => a.getAttribute('href')?.slice(0, 44))
                  : null,
                buildHeroErr: document.documentElement.dataset.miruHeroErr || null,
                withWatchAnchor: [...document.querySelectorAll('ytd-rich-item-renderer')]
                  .filter((c) => c.querySelector('a#thumbnail[href*="/watch"], a[href*="/watch?v="]')).length,
                sample: [...document.querySelectorAll('ytd-rich-item-renderer')].slice(0, 5).map((c) => ({
                  hidden: c.dataset.miruHidden || null,
                  title: (c.querySelector('#video-title, a#video-title-link, h3 a')?.textContent || '').trim().slice(0, 34),
                  anchor: c.querySelector('a#thumbnail[href*="/watch"], a[href*="/watch?v="]')?.getAttribute('href')?.slice(0, 26) || null,
                  short: !!c.querySelector('a[href*="/shorts/"], [overlay-style="SHORTS"], [class*="shortsLockup"]'),
                })),
              };
            }
            const art = h.querySelector('.miru-hero-art');
            return {
              built: true,
              title: h.querySelector('.miru-hero-title')?.textContent.slice(0, 50),
              channel: h.querySelector('.miru-hero-meta')?.textContent.slice(0, 30),
              artLoaded: !!(art?.naturalWidth),
              artRes: art ? art.naturalWidth + 'x' + art.naturalHeight : null,
              artSrc: art?.src.includes('maxres') ? 'maxres' : 'hq-fallback',
              height: Math.round(h.getBoundingClientRect().height),
              sourceCardHidden: document.querySelectorAll('[data-miru-hero-src]').length,
              duplicates: document.querySelectorAll('.miru-hero').length,
            };
          })(),
          adPatch: window.__miruAds ? { active: true, pruned: window.__miruAds.pruned, keys: window.__miruAds.keys } : { active: false },
          hiddenSample: [...document.querySelectorAll('[data-miru-hidden]')].slice(0, 8).map((el) => ({
            why: el.dataset.miruHidden,
            title: (el.querySelector('#video-title, a#video-title-link, h3 a, .yt-lockup-metadata-view-model__title')?.textContent || el.tagName).trim().slice(0, 62),
          })),
          keptSample: [...document.querySelectorAll('ytd-video-renderer:not([data-miru-hidden]), yt-lockup-view-model:not([data-miru-hidden])')].slice(0, 6).map((el) =>
            (el.querySelector('#video-title, a#video-title-link, h3 a, .yt-lockup-metadata-view-model__title')?.textContent || '').trim().slice(0, 62)),
        };
      })()`;
      const res = await yt.webContents.executeJavaScript(probe, true);
      console.log('SELFTEST ' + JSON.stringify(res, null, 2));
    } catch (err) {
      console.error('[selftest] failed:', err.message);
    }
    app.quit();
  }, wait);
}

/**
 * --import-session <firefox-profile-dir>
 *
 * Google refuses sign-in from any embedded browser as a matter of policy
 * (accounts.google.com/v3/signin/rejected), so miru cannot log you in itself and
 * no UA spoof reliably gets through. Instead: sign in normally in your own
 * browser, then move that session across with this.
 *
 * scripts/read-cookies.mjs does the reading in a child process and pipes JSON
 * over stdout — nothing is written to a temp file, nothing leaves the machine.
 */
// Firefox keeps cookies in plain SQLite; Chromium encrypts them and needs the
// keyring. Pick the reader by what's actually in the directory — and look one
// level down, since people usually point at the browser root, not a profile.
function pickReader(dir) {
  const probe = (d) => {
    if (fs.existsSync(path.join(d, 'Cookies'))) return 'read-cookies-chromium.mjs';
    if (fs.existsSync(path.join(d, 'cookies.sqlite'))) return 'read-cookies.mjs';
    return null;
  };
  const direct = probe(dir);
  if (direct) return direct;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = probe(path.join(dir, entry.name));
      if (nested) return nested;
    }
  } catch { /* unreadable; fall through so the reader reports it properly */ }
  return 'read-cookies.mjs';
}

// Run the appropriate cookie reader as a child process. It decrypts youtube/
// google cookies (v10 constant key, v11 keyring, Firefox plaintext) and pipes
// JSON over stdout — nothing is written to a temp file, nothing leaves the box.
function readCookiesFromProfile(profileDir) {
  const reader = path.join(ROOT, 'scripts', pickReader(profileDir));
  console.log(`[import] using ${path.basename(reader)}`);
  return new Promise((resolve, reject) => {
    // Run the reader through miru's own binary as a plain Node process, so it
    // works on machines with no system Node installed (e.g. a normal Windows box).
    const child = spawn(process.execPath, [reader, profileDir], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', (err) => reject(new Error(`could not run node: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('cookie reader exited with an error'));
      try { resolve(JSON.parse(out)); }
      catch { reject(new Error('could not parse cookie data')); }
    });
  });
}

// Install rows into the embedded youtube partition through Chromium's own cookie
// API — which sets SameSite/Secure/partition state correctly. Writing them
// straight into the SQLite file instead gets them rejected by YouTube.
async function installCookies(rows) {
  const jar = session.fromPartition(YT_PARTITION).cookies;
  const SAME_SITE = ['no_restriction', 'lax', 'strict'];
  let ok = 0;
  let failed = 0;
  let signedIn = false;

  for (const c of rows) {
    const host = c.host.replace(/^\./, '');
    const secure = !!c.isSecure;
    let sameSite = SAME_SITE[c.sameSite] || 'lax';
    // sameSite=None is only legal on a secure cookie; Chromium rejects the pair.
    if (sameSite === 'no_restriction' && !secure) sameSite = 'lax';

    try {
      await jar.set({
        url: `${secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
        name: c.name,
        value: c.value,
        domain: c.host,
        path: c.path || '/',
        secure,
        httpOnly: !!c.isHttpOnly,
        sameSite,
        expirationDate: c.expiry > 0 ? c.expiry : undefined,
      });
      ok += 1;
      // The first-party youtube session cookies are the proof a login landed.
      if (/(^|\.)youtube\.com$/.test(host) && (c.name === 'LOGIN_INFO' || c.name === 'SID')) signedIn = true;
    } catch {
      failed += 1;
    }
  }

  await jar.flushStore();
  return { ok, failed, signedIn };
}

/**
 * --import-session <browser-profile-dir>
 *
 * Google refuses sign-in from any embedded browser as a matter of policy
 * (accounts.google.com/v3/signin/rejected), so miru cannot log you in itself.
 * Instead: sign in normally in your own browser, then move that session across
 * with this. The "Sign in" button in the app automates the same path.
 */
async function importSession(profileDir) {
  if (!profileDir) {
    console.error('[import] usage: --import-session <browser-profile-dir>');
    return app.quit();
  }
  try {
    const rows = await readCookiesFromProfile(profileDir);
    const { ok, failed } = await installCookies(rows);
    console.log(`[import] imported ${ok} cookies${failed ? `, ${failed} rejected` : ''}.`);
    console.log('[import] start miru normally — you should be signed in.');
  } catch (err) {
    console.error(`[import] ${err.message}`);
  }
  app.quit();
}

// ---------------------------------------------------------------- login helper
//
// Google accepts sign-in from a real, standalone browser but not from miru's
// embedded view. So on "Sign in" we launch whatever Chromium/Firefox the user
// has, in a throwaway profile we control, pointed at the YouTube login. When the
// user finishes and closes that window we read its cookies back and install them
// — then delete the profile. Nothing touches the user's own browser profile.

const LOGIN_URL = 'https://accounts.google.com/ServiceLogin?service=youtube&continue='
  + encodeURIComponent('https://www.youtube.com/');

// Ordered by preference; first one present wins. Chromium family is tried first
// because its throwaway profile can be forced to plaintext-key cookies with
// --password-store=basic, so reading them back needs no keyring.
const BROWSER_CANDIDATES = [
  { names: ['brave', 'brave-browser'], family: 'chromium' },
  { names: ['google-chrome-stable', 'google-chrome'], family: 'chromium' },
  { names: ['chromium', 'chromium-browser'], family: 'chromium' },
  { names: ['microsoft-edge-stable', 'microsoft-edge'], family: 'chromium' },
  { names: ['vivaldi-stable', 'vivaldi'], family: 'chromium' },
  { names: ['firefox', 'librewolf', 'zen', 'zen-browser'], family: 'firefox' },
];
const BROWSER_FALLBACKS = [
  { path: '/opt/brave-bin/brave', family: 'chromium' },
  { path: '/usr/bin/brave', family: 'chromium' },
  { path: '/usr/bin/chromium', family: 'chromium' },
];

// Windows installs live under Program Files / LocalAppData, not on PATH.
const WIN_BROWSERS = [
  ['BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'chromium'],
  ['Google\\Chrome\\Application\\chrome.exe', 'chromium'],
  ['Chromium\\Application\\chrome.exe', 'chromium'],
  ['Microsoft\\Edge\\Application\\msedge.exe', 'chromium'],
  ['Vivaldi\\Application\\vivaldi.exe', 'chromium'],
  ['Mozilla Firefox\\firefox.exe', 'firefox'],
];
const MAC_BROWSERS = [
  ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'chromium'],
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'chromium'],
  ['/Applications/Chromium.app/Contents/MacOS/Chromium', 'chromium'],
  ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'chromium'],
  ['/Applications/Firefox.app/Contents/MacOS/firefox', 'firefox'],
];

function onPath(cmd) {
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}

function findBrowser() {
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      for (const [rel, family] of WIN_BROWSERS) {
        const p = path.join(root, rel);
        if (fs.existsSync(p)) return { path: p, family };
      }
    }
    return null;
  }
  if (process.platform === 'darwin') {
    for (const [p, family] of MAC_BROWSERS) {
      if (fs.existsSync(p)) return { path: p, family };
    }
    return null;
  }
  for (const cand of BROWSER_CANDIDATES) {
    for (const name of cand.names) {
      const found = onPath(name);
      if (found) return { path: found, family: cand.family };
    }
  }
  for (const cand of BROWSER_FALLBACKS) {
    if (fs.existsSync(cand.path)) return { path: cand.path, family: cand.family };
  }
  return null;
}

// A launched profile keeps its cookie store at the user-data-dir root, inside a
// Default profile, or under a Network subfolder — depending on browser/version.
function resolveProfileDir(root) {
  const hasStore = (d) => fs.existsSync(path.join(d, 'Cookies')) || fs.existsSync(path.join(d, 'cookies.sqlite'));
  for (const c of [root, path.join(root, 'Default'), path.join(root, 'Default', 'Network')]) {
    if (hasStore(c)) return c;
  }
  return root;
}

let loginInProgress = false;

async function loginWithBrowser() {
  if (loginInProgress) return { ok: false, reason: 'busy' };
  const browser = findBrowser();
  if (!browser) return { ok: false, reason: 'no-browser' };

  loginInProgress = true;
  const status = (phase, extra = {}) => send('login:status', { phase, ...extra });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miru-login-'));
  const label = path.basename(browser.path);

  try {
    status('launching', { browser: label });
    const args = browser.family === 'chromium'
      ? [
          `--user-data-dir=${tmp}`,
          '--password-store=basic', // forces v10 (constant-key) cookies — no keyring needed to read back
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-sync',
          '--new-window',
          LOGIN_URL,
        ]
      : ['-no-remote', '-new-instance', '-profile', tmp, LOGIN_URL];

    const child = spawn(browser.path, args, { stdio: 'ignore' });
    status('waiting', { browser: label });

    // The login is done when the user closes the browser window.
    await new Promise((resolve) => {
      child.on('close', resolve);
      child.on('error', resolve);
    });

    status('importing');
    let rows;
    try {
      rows = await readCookiesFromProfile(resolveProfileDir(tmp));
    } catch (err) {
      status('failed', { reason: 'read-failed' });
      return { ok: false, reason: 'read-failed', detail: err.message };
    }

    const { ok, signedIn } = await installCookies(rows);
    if (!signedIn) {
      status('failed', { reason: 'no-session' });
      return { ok: false, reason: 'no-session', imported: ok };
    }

    // Reload the embedded view so it picks up the freshly-installed session.
    if (yt && !yt.webContents.isDestroyed()) yt.webContents.loadURL(HOME);
    status('done', { imported: ok });
    return { ok: true, imported: ok };
  } finally {
    loginInProgress = false;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

process.on('unhandledRejection', (err) => {
  console.warn('[miru] unhandled rejection:', err?.message || err);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => { flushCache(); flushChannelMap(); app.quit(); });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
}
