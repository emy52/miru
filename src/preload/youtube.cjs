'use strict';
/**
 * Runs inside the YouTube page (isolated world — DOM only, no page globals).
 * Three jobs: restyle, filter the feed, and make ads not happen.
 */
const { ipcRenderer, webFrame } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { classify } = require('../shared/match.cjs');

const INJECT_DIR = path.join(__dirname, '..', 'inject');

let settings = null;
let rules = null;
let stats = { hidden: 0, byCategory: {} };

// ------------------------------------------------------------------ styling

/**
 * Main-world injection. webFrame.executeJavaScript runs in the page's own world,
 * and the preload runs before any page script, so this lands early enough to
 * patch JSON.parse before YouTube's bundle reads the player response.
 */
function injectAdPatch() {
  try {
    const code = fs.readFileSync(path.join(INJECT_DIR, 'ytads.js'), 'utf8');
    webFrame.executeJavaScript(code, false);
  } catch (err) {
    console.warn('[miru] ad patch failed:', err.message);
  }
}

let cssHandles = [];

/**
 * webFrame.insertCSS, not a <style> tag: at preload time document.documentElement
 * may not exist yet, and anything appended to it can be discarded when the parser
 * builds the real document. insertCSS is frame-level and survives that.
 */
function injectStyles() {
  for (const handle of cssHandles) {
    try { webFrame.removeInsertedCSS(handle); } catch { /* frame already gone */ }
  }
  cssHandles = [];
  for (const file of ['theme.css', 'filter.css']) {
    try {
      const css = fs.readFileSync(path.join(INJECT_DIR, file), 'utf8');
      cssHandles.push(webFrame.insertCSS(css));
    } catch (err) {
      console.warn(`[miru] could not inject ${file}:`, err.message);
    }
  }
}

// ------------------------------------------------------------------ feed filtering

const CARDS = [
  'ytd-rich-item-renderer',
  'ytd-video-renderer',
  'ytd-compact-video-renderer',
  'ytd-grid-video-renderer',
  'ytd-playlist-video-renderer',
  'yt-lockup-view-model',
].join(',');

// Shorts shelves have had many names across redesigns; match the container by
// what it holds as well as by tag, or you get an empty gap with a heading.
const SHELVES = [
  'ytd-rich-shelf-renderer[is-shorts]',
  'ytd-reel-shelf-renderer',
  'grid-shelf-view-model',
  'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])',
  'ytd-rich-section-renderer:has(a[href^="/shorts"])',
  'ytd-shelf-renderer:has(a[href^="/shorts"])',
  'ytd-item-section-renderer:has(> #contents > ytd-reel-shelf-renderer)',
  'ytd-rich-section-renderer:has(ytd-statement-banner-renderer)',
].join(',');

const TITLE_SEL = '#video-title, a#video-title-link, yt-formatted-string#video-title, h3 a, .yt-lockup-metadata-view-model__title, [class*="lockup-metadata"] a[href*="/watch"]';
// Watch-page recommendations use yt-lockup-view-model, whose channel name sits in
// a metadata row with no stable id — hence the broad net. Verified: without the
// last two selectors, 0 of 22 watch-page cards got a block button.
const CHANNEL_SEL = [
  'ytd-channel-name a', 'ytd-channel-name #text',
  '#channel-name a', '#channel-name #text',
  '.yt-content-metadata-view-model__metadata-text',
  '[class*="metadata-view-model"] a[href^="/@"]',
  '[class*="metadata-row"] a[href^="/@"]',
  'a[href^="/@"]',
].join(',');

function readCard(card) {
  const titleEl = card.querySelector(TITLE_SEL);
  const title = (titleEl?.getAttribute('title') || titleEl?.textContent || card.querySelector('a[href*="/watch"]')?.getAttribute('aria-label') || '').trim();
  const channelEl = card.querySelector(CHANNEL_SEL);
  const channel = (channelEl?.textContent || '').trim();
  const isShort = !!card.querySelector('a[href*="/shorts/"], [overlay-style="SHORTS"], [class*="shortsLockup"]');
  const href = card.querySelector('a#thumbnail[href*="/watch"], a[href*="/watch?v="]')?.getAttribute('href') || '';
  const videoId = /[?&]v=([\w-]{6,})/.exec(href)?.[1] || null;
  return { title, channel, isShort, videoId };
}

const pending = new Map(); // key -> [cards awaiting an LLM verdict]
const keyOf = (v) => `${v.channel.toLowerCase()}|${v.title.toLowerCase()}`.slice(0, 300);

// Each distinct video votes for its channel's category at most once per session.
// Keyed by video, not channel, so two different caught uploads can establish a
// channel in a single sitting; scan() re-runs constantly, hence the dedupe.
const voted = new Set();
// Channels we've already asked YouTube to identify this session.
const asked = new Set();

function hide(card, category) {
  if (card.dataset.miruHidden) return false;
  card.dataset.miruHidden = category || 'filtered';
  stats.hidden += 1;
  stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
  return true;
}

function show(card) {
  if (!card.dataset.miruHidden) return;
  delete card.dataset.miruHidden;
}

function scan() {
  if (!rules || !settings) return;
  let changed = false;
  const unknown = [];
  const votes = [];
  const identify = [];
  const reputation = rules.channelReputation || {};

  for (const card of document.querySelectorAll(CARDS)) {
    const video = readCard(card);
    if (!video.title) continue; // still hydrating

    // Re-evaluate from scratch each pass so toggling Focus off restores cards.
    show(card);

    const verdict = classify(rules, video, { focus: settings.focus, hideShorts: settings.hideShorts });

    // First time we've seen this channel: ask YouTube what it's known for.
    if (video.channel && video.videoId && !reputation[video.channel.toLowerCase()]?.yt) {
      const ck = video.channel.toLowerCase();
      if (!asked.has(ck)) {
        asked.add(ck);
        identify.push({ channel: video.channel, videoId: video.videoId });
      }
    }

    if (verdict.learn && video.channel) {
      const vk = `${keyOf(video)}|${verdict.learn}`;
      if (!voted.has(vk)) {
        voted.add(vk);
        votes.push({ channel: video.channel, category: verdict.learn });
      }
    }

    if (verdict.verdict === 'block') {
      changed = hide(card, verdict.category) || changed;
      continue;
    }
    if (verdict.verdict === 'unknown' && settings.focus && settings.llm?.enabled) {
      const k = keyOf(video);
      if (!pending.has(k)) {
        pending.set(k, []);
        unknown.push(video);
      }
      pending.get(k).push(card);
    }
    attachBlockButton(card, video);
  }

  if (settings.hideShorts) {
    for (const shelf of document.querySelectorAll(SHELVES)) changed = hide(shelf, 'shorts') || changed;
  }

  if (identify.length) ipcRenderer.send('filter:identify', identify);
  if (votes.length) ipcRenderer.send('filter:learn', votes);
  if (unknown.length) requestVerdicts(unknown);
  if (changed) ipcRenderer.send('yt:stats', { ...stats });

  try {
    buildHero();
  } catch (err) {
    // Never let the hero take the filter down with it.
    // Isolated world: the page's window is a different global, so report
    // through the DOM, which both worlds actually share.
    document.documentElement.dataset.miruHeroErr = err.message;
    console.warn('[miru] hero failed:', err);
  }
}

async function requestVerdicts(videos) {
  try {
    const verdicts = await ipcRenderer.invoke('filter:resolve', videos);
    let changed = false;
    for (const [k, category] of Object.entries(verdicts || {})) {
      const blocked = (rules.focus?.blockCategories || []).includes(category);
      for (const card of pending.get(k) || []) {
        if (blocked && document.contains(card)) changed = hide(card, category) || changed;
      }
      pending.delete(k);
    }
    if (changed) ipcRenderer.send('yt:stats', { ...stats });
  } catch {
    /* main is gone or the model timed out — leave the cards visible */
  }
}

// A per-card "not this channel" control: the only practical way to teach the
// filter about channels no keyword list will ever cover.
function attachBlockButton(card, video) {
  if (!video.channel || card.querySelector(':scope > .miru-block')) return;
  const btn = document.createElement('button');
  btn.className = 'miru-block';
  btn.type = 'button';
  btn.title = `Hide everything from ${video.channel}`;
  btn.textContent = '✕';
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.invoke('filter:block-channel', video.channel);
  });
  card.appendChild(btn);
}

// ------------------------------------------------------------------ opening stage
//
// Tier 3: the signature home composition mirrors the first three real videos
// into a cinematic stage. It never invents editorial data and never reparents a
// Polymer node: source cards stay in place and are merely hidden from layout.

let heroId = null;

function removeHero() {
  document.querySelector('.miru-hero')?.remove();
  for (const el of document.querySelectorAll('[data-miru-hero-src]')) {
    delete el.dataset.miruHeroSrc;
  }
  heroId = null;
}

function pickFeatureCards(limit = 3) {
  const adContent = [
    'ytd-ad-slot-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-promoted-video-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-display-ad-renderer',
    'ytd-banner-promo-renderer',
    '[class*="promoted"]',
    'a[href*="googleadservices.com"]',
    'a[href*="/pagead/"]',
  ].join(',');

  const picks = [];
  const seen = new Set();
  for (const card of document.querySelectorAll('ytd-rich-item-renderer')) {
    // Never spotlight something Focus just filtered out.
    if (card.dataset.miruHidden) continue;
    // Network blocking can leave a hydrated-looking promoted card behind. It
    // may even contain a /watch link, so reject it by ancestry/content before
    // reading any metadata rather than trusting the destination alone.
    if (card.matches(adContent) || card.querySelector(adContent)) continue;
    const video = readCard(card);
    // A real feed video has creator metadata. Promo CTAs commonly yield a
    // generic title such as "Watch" and no channel, which must never become
    // the app's signature spotlight.
    if (!video.title || !video.channel || video.isShort) continue;
    const anchor = card.querySelector('a#thumbnail[href*="/watch"], a[href*="/watch?v="]');
    const id = /[?&]v=([\w-]+)/.exec(anchor?.getAttribute('href') || '')?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    picks.push({ ...video, id, card, anchor });
    if (picks.length === limit) break;
  }
  return picks;
}

function buildHero() {
  if (location.pathname !== '/') return removeHero();

  const grid = document.querySelector('ytd-rich-grid-renderer');
  if (!grid?.parentElement) return;

  const picks = pickFeatureCards();
  if (!picks.length) return;
  const signature = picks.map((pick) => pick.id).join(':');
  // Idempotent: the MutationObserver fires constantly, so bail if nothing moved.
  if (heroId === signature && document.querySelector('.miru-hero')) return;

  removeHero();
  heroId = signature;

  // YouTube enforces Trusted Types, so `innerHTML = ...` throws outright.
  // Everything here is built with real DOM calls.
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const imageFor = (pick, className) => {
    const image = el('img', className);
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    image.src = `https://i.ytimg.com/vi/${pick.id}/maxresdefault.jpg`;
    image.addEventListener('error', () => {
      image.src = `https://i.ytimg.com/vi/${pick.id}/hqdefault.jpg`;
    }, { once: true });
    return image;
  };

  const makeInteractive = (node, pick) => {
    node.tabIndex = 0;
    node.setAttribute('role', 'link');
    node.setAttribute('aria-label', `Watch ${pick.title}`);
    const open = () => pick.anchor ? pick.anchor.click() : (location.href = `/watch?v=${pick.id}`);
    node.addEventListener('click', open);
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      open();
    });
  };

  const hero = el('section', 'miru-hero');
  const heading = el('header', 'miru-stage-heading');
  heading.append(
    (() => { const group = el('div', 'miru-stage-heading-copy'); group.append(el('span', '', 'OPENING SEQUENCE'), el('h2', '', 'Selected by your feed')); return group; })(),
    el('span', 'miru-stage-note', 'LIVE · PERSONAL · UNINTERRUPTED'),
  );

  const stage = el('div', 'miru-stage-grid');
  const primary = el('article', 'miru-feature-primary');
  makeInteractive(primary, picks[0]);
  const art = imageFor(picks[0], 'miru-hero-art');
  const copy = el('div', 'miru-hero-copy');
  copy.append(
    el('div', 'miru-hero-eyebrow', 'FIRST FRAME'),
    el('h3', 'miru-hero-title', picks[0].title),
    el('div', 'miru-hero-meta', picks[0].channel),
    (() => { const actions = el('div', 'miru-hero-actions'); actions.append(el('span', 'miru-hero-play', 'Enter film')); return actions; })(),
  );
  primary.append(art, el('div', 'miru-hero-scrim'), copy, el('span', 'miru-feature-number', '01'));
  stage.append(primary);

  if (picks.length > 1) {
    const side = el('div', 'miru-feature-side');
    for (const [index, pick] of picks.slice(1).entries()) {
      const card = el('article', 'miru-feature-minor');
      makeInteractive(card, pick);
      const miniCopy = el('div', 'miru-minor-copy');
      miniCopy.append(el('span', 'miru-minor-index', `0${index + 2}`), el('h3', '', pick.title), el('span', 'miru-minor-meta', pick.channel));
      card.append(imageFor(pick, 'miru-minor-art'), el('div', 'miru-minor-scrim'), miniCopy, el('span', 'miru-minor-arrow', '↗'));
      side.append(card);
    }
    stage.append(side);
  }

  const footer = el('footer', 'miru-stage-footer');
  footer.append(el('span', '', 'No ads · No Shorts'), el('span', '', 'Continue into your signal ↓'));
  hero.append(heading, stage, footer);

  grid.parentElement.insertBefore(hero, grid);
  // Marked with our own attribute, not data-miru-hidden, so scan()'s reset pass
  // doesn't keep un-hiding it.
  for (const pick of picks) pick.card.dataset.miruHeroSrc = '1';
}

// ------------------------------------------------------------------ ads

let restoreMuted = null;

function killAds() {
  const player = document.querySelector('.html5-video-player');
  if (!player) return;

  const adShowing = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
  const video = player.querySelector('video');

  if (adShowing && video) {
    if (restoreMuted === null) restoreMuted = video.muted;
    video.muted = true;
    // Seeking to the end is the fastest way through an unskippable pre/mid-roll.
    if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = video.duration;
    else video.playbackRate = 16;
    document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-survey-answer-text')?.click();
  } else if (restoreMuted !== null && video) {
    video.muted = restoreMuted;
    video.playbackRate = 1;
    restoreMuted = null;
  }

  document.querySelector('.ytp-ad-overlay-close-button, .ytp-ad-overlay-close-container button')?.click();

  // "Ad blockers violate YouTube's Terms of Service" nag — dismiss and resume.
  const nag = document.querySelector('ytd-enforcement-message-view-model, tp-yt-paper-dialog ytd-enforcement-message-view-model');
  if (nag) {
    nag.closest('tp-yt-paper-dialog')?.remove();
    document.querySelector('tp-yt-iron-overlay-backdrop')?.remove();
    document.body.style.overflow = '';
    if (video?.paused) video.play().catch(() => {});
  }
}

// ------------------------------------------------------------ sponsor skip
// Skips ONLY crowd-sourced "sponsor" and "selfpromo" segments, nothing else.
let sbVideoId = null;
let sbSegments = [];
let sbLast = null;
let sbToast = null;

function sbShowToast(label, from) {
  sbToast?.remove();
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:96px;transform:translateX(-50%);display:flex;align-items:center;gap:14px;padding:10px 16px;border:1px solid rgba(170,147,255,.4);border-radius:12px;background:rgba(14,12,34,.94);color:#f0edf7;font:600 13px system-ui;box-shadow:0 14px 40px rgba(0,0,0,.6);backdrop-filter:blur(14px)';
  el.append(document.createTextNode(`Skipped ${label}`));
  const undo = document.createElement('button');
  undo.textContent = 'Undo';
  undo.style.cssText = 'border:0;border-radius:8px;padding:5px 11px;background:linear-gradient(135deg,#3d67ff,#7a4ee8);color:#fff;font:700 12px system-ui;cursor:pointer';
  undo.onclick = () => { const v = document.querySelector('.html5-video-player video'); if (v) { sbLast = { start: from, end: Infinity, off: true }; v.currentTime = from; } el.remove(); };
  el.append(undo);
  document.body.append(el);
  sbToast = el;
  setTimeout(() => { if (sbToast === el) { el.remove(); sbToast = null; } }, 5000);
}

async function sponsorTick() {
  if (!settings?.sponsorSkip) return;
  const id = location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
  if (id !== sbVideoId) {
    sbVideoId = id; sbSegments = []; sbLast = null;
    if (id) {
      const segs = await ipcRenderer.invoke('sb:segments', id).catch(() => []);
      if (sbVideoId === id) sbSegments = segs;
    }
  }
  if (!sbSegments.length) return;
  const player = document.querySelector('.html5-video-player');
  const video = player?.querySelector('video');
  if (!video || video.paused || player.classList.contains('ad-showing')) return;
  const t = video.currentTime;
  const seg = sbSegments.find((x) => t >= x.start && t < x.end - 0.4);
  if (!seg || (sbLast?.off && sbLast.start === seg.start)) return; // user hit Undo
  video.currentTime = seg.end;
  sbShowToast(seg.category === 'sponsor' ? 'sponsor' : 'self-promotion', seg.start);
}

// ------------------------------------------------------------------ shorts

function redirectShorts() {
  if (!settings?.hideShorts) return;
  const m = /^\/shorts\/([\w-]+)/.exec(location.pathname);
  if (m) location.replace(`/watch?v=${m[1]}`);
}

// Surface state on <html> so filter.css can react without extra plumbing.
function applyDocState() {
  const root = document.documentElement;
  root.dataset.miruFocus = settings?.focus ? 'on' : 'off';
  root.dataset.miruDim = rules?.focus?.dimInsteadOfHide ? 'on' : 'off';
  root.dataset.miruShorts = settings?.hideShorts ? 'hidden' : 'shown';
}

// ------------------------------------------------------------------ boot

injectAdPatch();
injectStyles();

(async () => {
  try {
    const ctx = await ipcRenderer.invoke('filter:context');
    settings = ctx.settings;
    rules = ctx.rules;
  } catch {
    settings = { focus: false, hideShorts: true };
    rules = { categories: {}, focus: {}, channels: {}, rescue: {} };
  }

  ipcRenderer.on('settings:changed', (_e, ctx) => {
    settings = ctx.settings;
    rules = ctx.rules;
    stats = { hidden: 0, byCategory: {} };
    pending.clear();
    removeHero(); // focus may have filtered out whatever was being spotlighted
    applyDocState();
    scan();
    redirectShorts();
  });

  // Rules-only update (a channel just became established). Keep stats and the
  // hero as they are — this is not a settings change the user made.
  ipcRenderer.on('filter:rules', (_e, next) => {
    if (!next) return;
    rules = next;
    scan();
  });

  const start = () => {
    applyDocState();
    redirectShorts();
    scan();

    // YouTube rebuilds the feed constantly; coalesce bursts into one scan.
    let timer = null;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(scan, 180);
    }).observe(document.documentElement, { childList: true, subtree: true });

    // Modern YouTube can mutate continuously (animated previews, live badges,
    // player telemetry), which may keep a pure debounce from ever settling.
    // A slow idempotent safety pass guarantees newly hydrated cards are picked
    // up without turning the observer into a hot loop.
    setInterval(scan, 2500);
    setInterval(killAds, 300);
    setInterval(sponsorTick, 250);
    for (const ev of ['yt-navigate-finish', 'yt-page-data-updated']) {
      document.addEventListener(ev, () => { redirectShorts(); scan(); });
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
