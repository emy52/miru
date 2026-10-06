'use strict';

const { win, yt, settings: settingsApi, llm } = window.miru;
const $ = (id) => document.getElementById(id);

// Every label is miru's own language, but every destination remains a real
// YouTube route. The interface never implies data the app does not have.
const NAV = [
  {
    section: null,
    items: [
      { path: '/',                   label: 'For you',      glyph: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6.5 10.5V20h11v-9.5"/>' },
      { path: '/feed/subscriptions', label: 'Following',    glyph: '<rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="m10 9.5 5 2.5-5 2.5z"/>' },
    ],
  },
  {
    section: 'Memory',
    items: [
      { path: '/feed/history',     label: 'Recently seen', glyph: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>' },
      { path: '/playlist?list=WL', label: 'The queue',     glyph: '<path d="M4 6h11M4 11h11M4 16h7"/><path d="M16.5 13.5v6l4.5-3z"/>' },
      { path: '/playlist?list=LL', label: 'Loved',         glyph: '<path d="M12 20s-7.5-4.7-7.5-10a4.2 4.2 0 0 1 7.5-2.6A4.2 4.2 0 0 1 19.5 10c0 5.3-7.5 10-7.5 10z"/>' },
      { path: '/feed/you',         label: 'Your archive',  glyph: '<circle cx="12" cy="8.5" r="3.6"/><path d="M5 20c.6-3.7 3.4-5.6 7-5.6s6.4 1.9 7 5.6"/>' },
    ],
  },
  {
    section: 'Change medium',
    items: [
      { url: 'https://music.youtube.com/', label: 'Listening room', tag: 'AUDIO', glyph: '<circle cx="7" cy="17.5" r="2.8"/><circle cx="18" cy="15.5" r="2.8"/><path d="M9.8 17.5v-11l11-2v11"/>' },
    ],
  },
];

let state = { settings: null, url: '' };

// ------------------------------------------------------------- nav

const navList = $('nav');
navList.innerHTML = NAV.map((group) => {
  const label = group.section ? `<li class="nav-label">${group.section}</li>` : '';
  const items = group.items.map((item) => {
    const target = item.url || item.path;
    const extra = item.tag ? `<span class="tag">${item.tag}</span>` : '';
    return `<li><button data-target="${target}" title="${item.label}">
      <span class="glyph"><svg viewBox="0 0 24 24">${item.glyph}</svg></span>
      <span class="label">${item.label}</span>${extra}
    </button></li>`;
  }).join('');
  return label + items;
}).join('');

navList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-target]');
  if (btn) yt.go(btn.dataset.target);
});

function markActive(url) {
  let path = '/';
  let host = 'www.youtube.com';
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
    host = u.host;
  } catch { /* about:blank during boot */ }

  for (const btn of navList.querySelectorAll('button')) {
    const target = btn.dataset.target;
    let active;
    if (target.startsWith('http')) {
      active = host === new URL(target).host;
    } else if (target === '/') {
      active = host.endsWith('youtube.com') && path === '/';
    } else {
      const [base, query] = target.split('?');
      active = path.startsWith(base) && (!query || path.includes(query.split('=')[1]));
    }
    btn.classList.toggle('active', active);
  }
}

function describeRoute(url, fallbackTitle = '') {
  try {
    const u = new URL(url);
    if (u.host === 'music.youtube.com') return { route: 'music', index: '09', kicker: 'LISTENING ROOM', title: 'Music' };
    if (u.pathname === '/watch') return { route: 'watch', index: '▶', kicker: 'NOW SCREENING', title: fallbackTitle.replace(/\s*-\s*YouTube\s*$/i, '') || 'Watching' };
    if (u.pathname === '/results') return { route: 'search', index: '02', kicker: 'SIGNAL FOUND', title: u.searchParams.get('search_query') || 'Search' };
    const match = NAV.flatMap((group) => group.items).find((item) => item.path && (item.path === '/' ? u.pathname === '/' : `${u.pathname}${u.search}`.startsWith(item.path.split('?')[0])));
    return { route: u.pathname === '/' ? 'home' : 'library', index: u.pathname === '/' ? '01' : '03', kicker: 'CURRENT ROOM', title: match?.label || fallbackTitle.replace(/\s*-\s*YouTube\s*$/i, '') || 'Archive' };
  } catch {
    return { route: 'home', index: '01', kicker: 'CURRENT ROOM', title: 'For you' };
  }
}

// ------------------------------------------------------------- titlebar

$('back').addEventListener('click', () => yt.go('back'));
$('forward').addEventListener('click', () => yt.go('forward'));
$('reload').addEventListener('click', () => yt.go('reload'));
$('min').addEventListener('click', () => win.minimize());
$('max').addEventListener('click', () => win.maximize());
$('close').addEventListener('click', () => win.close());

$('searchbar').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('search').value.trim();
  if (q) { yt.search(q); $('search').blur(); }
});

yt.onNavState((s) => {
  state.url = s.url;
  $('back').disabled = !s.canGoBack;
  $('forward').disabled = !s.canGoForward;
  document.body.classList.toggle('is-loading', !!s.loading);
  markActive(s.url);

  const context = describeRoute(s.url, s.title);
  document.body.dataset.route = context.route;
  document.querySelector('.context-index').textContent = context.index;
  $('page-kicker').textContent = context.kicker;
  $('page-title').textContent = context.title;

  try {
    const u = new URL(s.url);
    if (u.pathname === '/results') $('search').value = u.searchParams.get('search_query') || '';
  } catch { /* ignore */ }
});

win.onState(({ maximized }) => {
  $('max').title = maximized ? 'Restore' : 'Maximise';
});

win.onVideoFullscreen(({ fullscreen }) => {
  document.body.classList.toggle('is-video-fullscreen', !!fullscreen);
});

// ------------------------------------------------------------- focus

const focusSwitch = $('focus-switch');
const focusStats = $('focus-stats');

focusSwitch.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-focus]');
  if (!btn) return;
  const wanted = btn.dataset.focus === 'on';
  if (wanted !== state.settings.focus) settingsApi.set({ focus: wanted });
});

$('sponsor-toggle').addEventListener('click', () => settingsApi.set({ sponsorSkip: !state.settings.sponsorSkip }));

function renderSettings(s) {
  state.settings = s;
  $('sponsor-toggle').setAttribute('aria-checked', String(!!s.sponsorSkip));
  $('sponsor-label').textContent = s.sponsorSkip ? 'On' : 'Off';
  document.body.dataset.focus = s.focus ? 'on' : 'off';
  document.body.classList.toggle('collapsed', !!s.sidebarCollapsed);
  $('ad-dot').classList.toggle('on', !!s.adblock);
  $('ad-text').textContent = s.adblock ? 'Shield on' : 'Shield off';
  $('llm-dot').classList.toggle('on', !!s.llm?.enabled);
  $('llm-text').textContent = s.llm?.enabled ? 'Local mind on' : 'Local mind off';
  if (!s.focus) { focusStats.hidden = true; focusStats.innerHTML = ''; }
}

yt.onStats((stats) => {
  if (stats?.reset) { focusStats.hidden = true; focusStats.innerHTML = ''; return; }
  const entries = Object.entries(stats.byCategory || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!entries.length) { focusStats.hidden = true; return; }
  focusStats.hidden = false;
  focusStats.innerHTML = entries.slice(0, 4)
    .map(([cat, n]) => `<span class="chip"><b>${n}</b> ${cat}</span>`)
    .join('');
});

settingsApi.onChanged(renderSettings);

$('collapse').addEventListener('click', () => {
  settingsApi.set({ sidebarCollapsed: !state.settings.sidebarCollapsed });
});

// ------------------------------------------------------------- sign in

const account = window.miru.account;
const signinBtn = $('signin');
const signinLabel = $('signin-label');
let signinResetTimer = null;

// A phase from main means "busy"; a terminal word is set by the click result.
const SIGNIN_STATUS = {
  launching: 'Opening browser…',
  waiting: 'Log in, then close it',
  importing: 'Bringing session in…',
};
const SIGNIN_ERRORS = {
  'no-browser': 'No browser found',
  'no-session': 'No sign-in detected',
  'read-failed': 'Couldn’t read session',
  busy: 'Already signing in…',
};

function setSignin(text, busy) {
  clearTimeout(signinResetTimer);
  signinLabel.textContent = text;
  signinBtn.classList.toggle('busy', !!busy);
}
function resetSigninSoon(text, delay = 4500) {
  signinResetTimer = setTimeout(() => setSignin(text, false), delay);
}

account.onStatus(({ phase }) => {
  if (SIGNIN_STATUS[phase]) setSignin(SIGNIN_STATUS[phase], true);
});

signinBtn.addEventListener('click', async () => {
  if (signinBtn.classList.contains('busy')) return;
  setSignin('Opening browser…', true);
  let res;
  try {
    res = await account.login();
  } catch {
    res = { ok: false, reason: 'read-failed' };
  }
  if (res?.ok) {
    setSignin('Signed in ✓', false);
    resetSigninSoon('Signed in ✓');
  } else {
    setSignin(SIGNIN_ERRORS[res?.reason] || 'Sign-in failed', false);
    resetSigninSoon('Sign in');
  }
});

// ------------------------------------------------------------- shortcuts

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('search').focus(); $('search').select(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    settingsApi.set({ focus: !state.settings.focus });
  } else if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); $('collapse').click(); }
  else if (e.key === 'Escape') $('search').blur();
});

// ------------------------------------------------------------- boot

(async () => {
  const { settings } = await settingsApi.get();
  renderSettings(settings);

  if (settings.llm?.enabled) {
    const probe = await llm.probe();
    $('llm-dot').classList.toggle('on', probe.ok);
    $('llm-text').textContent = probe.ok ? 'Local mind ready' : `Local mind: ${probe.reason}`;
  }
})();
