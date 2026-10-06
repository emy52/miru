# miru — handoff

Read this first. Terse by design: headings + gotchas, not a transcript.

## What it is
Electron (Chromium) YouTube client for Linux and Windows. Priority order: **looks first**,
then filtering, then ads.

Visual language is adapted from a design concept ("YouTube Nocturne"): electric violet on near-black,
sectioned sidebar with small-caps eyebrows, segmented switches, footer cards.
That concept is a *streaming-service dashboard* with fake data — its hero rails,
multi-view and music mode do not map onto embedded YouTube. Only the palette,
sidebar structure and control shapes were taken. Don't try to port its layout
wholesale; the middle of this app is YouTube's own DOM.

## Sponsor skip
`sponsorTick()` in `src/preload/youtube.cjs` + `sb:segments` in `src/main/index.js`.
Skips ONLY SponsorBlock `sponsor` and `selfpromo` segments (`SB_CATEGORIES`), never
intros/outros. Hash-prefix API (4 hex chars of sha256), cached per video, toast with
Undo, setting `sponsorSkip` (default on, sidebar switch above Sign in). Verified live: seek to 29s on a tagged video
lands on the segment end. Videos nobody has tagged are simply not skipped.

## Run from source
```
cd miru && npm install && npm start
```

## Package a portable copy
```
npm run package:windows  # dist/miru-win32-x64/ — run miru.exe
npm run package:linux    # dist/miru-linux-x64/ — run miru
```

## Layout
```
src/main/index.js       window, WebContentsView, all IPC, shorts redirect
src/main/store.js       settings + rules + verdict cache (~/.config/miru/)
src/main/adblock.js     Ghostery engine, network filters only
src/main/classifier.js  LLM tier + cache (optional, off by default)
src/shared/match.cjs    heuristic classifier — used by BOTH main and preload
src/preload/shell.cjs   contextBridge for the app chrome
src/preload/youtube.cjs in-page: inject CSS, scan feed, skip ads, kill shorts
src/inject/theme.css    the restyle (overrides YouTube's --yt-spec-* tokens)
src/inject/filter.css   hiding + per-card block button
src/renderer/           titlebar + sidebar UI
config/filters.default.json  keyword rules — shipped defaults
```

## Filtering model
Five tiers, in order. Anything unresolved stays **visible** — never hides on a guess.
1. channel allow/block list (`~/.config/miru/filters.json`, grown by the ✕ on each card)
2. keyword/regex scoring per category, minus a "rescue" score for educational signals
3. **channel identity** — YouTube's own category for the channel, see below
4. **channel reputation** — learned from the titles it does catch, see below
5. local LLM for titles tiers 1–4 had no opinion on — **off unless you enable it**

Tiers 3 and 4 both live in `~/.config/miru/channels.json`. They exist because
tier 2 measured badly on a real feed: **54 cards, 12 hidden, every one of them a
Short and not a single one gaming**, while "Why Everyone Is Playing Full AP Shen"
and "200 IQ Kalista" sailed through. After 3+4: gaming became the dominant block
reason and only music survived. Keyword lists alone do not work on a real feed.

### Channel identity — ask YouTube what a channel is known for
The strongest signal, and the one that actually fixed Quiet mode. Every watch page
carries YouTube's own label in its microformat (`"category":"Gaming"`). miru looks
it up **once per channel** and caches it in `channels.json` as `yt`; a feed of ~20
channels costs ~20 requests, once, ever. `focus.ytCategoryMap` maps YouTube's
label onto a miru category — only `Gaming` and `Comedy` by default. *Entertainment*
and *People & Blogs* are deliberately unmapped: too broad to block on.
- The fetch runs in the youtube partition (`session.fetch`) so it carries our
  cookies and UA and doesn't hit a consent wall. Max 3 concurrent.
- A resolved channel counts as one keyword hit — same weight as reputation, so a
  rescue word still saves a gaming channel's genuine tutorial.
- Measured live on a real feed: it correctly labelled `peng`, `polypuff`,
  `dokibird`, `valorant` as Gaming while leaving `fireship` (Science & Technology)
  and `marmarchan` (Music) alone.

### Channel reputation — why Quiet mode needed it
Tier 2 only reads the *title*, and real feed titles mostly don't contain the
keywords ("we finally beat it after 300 attempts", "Our worst episode yet").
Measured on realistic titles: **4 of 6 gaming/comedy videos scored 0 and were
kept**. No word list will ever enumerate every gaming or comedy channel, but the
*channel* is a near-perfect signal — so miru learns it.

- Every video the keywords positively categorise casts one vote for its channel
  (`classify()` returns `learn`, the page sends `filter:learn`, main persists).
- Past `focus.channelMinVotes` (default 2) the channel counts as **one extra
  keyword hit** — enough to trip `threshold` on a keyword-free title.
- **Reputation can never feed itself**: `learn` is computed from keyword evidence
  only (`kwBestScore`), never from the reputation hit. Otherwise one bad vote
  would snowball across a channel's whole catalogue.
- **Rescue still wins.** A learned gaming channel's genuine tutorial survives:
  "How I built my homelab from scratch" from a learned gaming channel scores
  −4 and is kept. Verified, along with 0 over-blocks on the legit set.
- Votes are deduped per *video* per session, so two different caught uploads can
  establish a channel in one sitting.
- Learning also runs with Focus **off**, so switching to Quiet already knows things.
- To unlearn: delete the entry (or the file) in `~/.config/miru/channels.json`.

Focus off = only Shorts are filtered. Focus on = also gaming/comedy/reaction/drama/clickbait.

## Shortcuts
`Ctrl+K` search · `Ctrl+Shift+F` toggle Focus · `Ctrl+B` collapse sidebar

## Gotchas (all hit for real, do not re-derive)
- **`npm install` + `npm start` now work.** package.json had lost `electron` and the
  `start` script. `prestart` runs `scripts/ensure-electron.mjs`, which repairs a missing
  or half-extracted Electron (npm 12 blocks postinstall; extract-zip bails silently) —
  so the first `npm start` prints "repairing…" once. `--shot`/`--selftest` do nothing
  while another miru is open: add `--user-data-dir=/some/tmp` to run beside it.
- **extract-zip silently bails** after one file, exit code 0. If `dist/` is
  missing or tiny, extract by hand:
  `bsdtar -xf ~/.cache/electron/*/electron-v*-linux-x64.zip -C node_modules/electron/dist`
  then `echo -n electron > node_modules/electron/path.txt`. No `unzip` needed.
- **Preloads must be `.cjs`.** package.json is `"type": "module"`, so a `.js`
  preload is parsed as ESM and Electron won't load it.
- **Cosmetic filters are off on purpose.** YouTube's CSP/trusted-types rejects
  Ghostery's scriptlet injection — it threw on every navigation. Our CSS covers it.
  If you re-enable them, expect that noise back.
- **UA is spoofed to plain Chrome.** Google refuses sign-in to UAs it reads as
  embedded. Don't remove the `CHROME_UA` in main/index.js.
- **In-stream ads are killed in `src/inject/ytads.js`, not by the blocker.** They
  can't be blocked at the network layer (same googlevideo.com hosts as the video).
  The fix is what uBO/Brave do: strip `adPlacements`/`playerAds`/`adSlots` out of
  the player JSON before the player reads it, via a MAIN-world hook on JSON.parse,
  Response.json and the `ytInitialPlayerResponse` setter. `killAds()` in the
  preload is only a backstop for anything that slips through.
  Verified: 28 descriptors pruned on one watch page.
- **Main-world injection = `webFrame.executeJavaScript` from the preload.** The
  preload's own isolated world cannot patch page globals like JSON.parse.
- **Swapping adblock engines will not fix video ads.** Brave uses adblock-rust,
  Ghostery uses its own; both do network + cosmetic filtering, and neither layer
  can see an in-stream ad. The scriptlet above is the part that matters.
- **`--selftest` navigates the live window.** Don't run it while using the app.
- **One instance only.** `requestSingleInstanceLock()` means `--selftest` /
  `--shot` silently do nothing (exit 0, no output) while miru is already open.
  Close it first, or you'll think the app is broken.
- **Chromium `expires_utc` overflows a JS number** (~1.3e16 microseconds since
  1601). node:sqlite throws unless you call `stmt.setReadBigInts(true)`, which
  then makes *every* integer column a BigInt — coerce them back. A synthetic-
  profile test caught this; it would have failed on any real Brave profile.
- **v11 (keyring) cookie decryption is untested.** It needs a real keyring, so it
  can only be proven on a machine with a real keyring. v10 paths are verified.
- **The two palettes must stay in step**: `src/renderer/shell.css` (chrome) and
  the `--miru-*` block in `src/inject/theme.css` (YouTube). They meet at a visible
  seam down the left edge of the page view.
- **Theme works via `--yt-spec-*` token overrides**, not per-element selectors.
  When YouTube redesigns, fix the tokens first before writing new selectors.
- **CSS must go through `webFrame.insertCSS`.** A `<style>` appended to
  `document.documentElement` at preload time silently does not survive — the
  parser is still building the document. This cost a debugging round.
- **`ready-to-show` fires during `loadFile`.** Register the listener *before*
  awaiting it or the window is created and never shown (blank/absent app).
- **Shorts shelves need container matching**, not link hiding. Hiding
  `a[href^="/shorts"]` alone leaves a "Shorts" heading over empty space; match the
  shelf with `:has()`. Shelf tag names change with every redesign — see SHELVES.

## State / open

### Sign-in: the "Sign in" button (login helper)
Google returns `accounts.google.com/v3/signin/rejected` for sign-in from any
embedded browser. Policy, not a bug — UA spoofing does not get through (a Firefox
UA on the accounts host is still wired up in `onBeforeSendHeaders`; it did not
help and is kept only because it costs nothing). **Do not sink more time into
UA tricks.** miru cannot log you in itself; the session has to come from a real
browser.

**Primary path — the sidebar "Sign in" button.** `loginWithBrowser()` in
`main/index.js` launches whatever Chromium/Firefox is installed
(`findBrowser()`), in a **throwaway profile miru controls** under the temp dir,
pointed at the YouTube login. You log in there (real browser → Google
accepts) and **closes that window**; miru then reads the temp profile's cookies
and installs them, and deletes the profile. It never touches your own
browser profile.
- Chromium is launched with `--password-store=basic`, which forces v10
  (constant-key) cookies — so reading them back needs **no keyring**. This is why
  the helper is robust where reading your *main* browser is not.
- Completion is detected by the launched browser process closing, then confirmed
  by a first-party youtube cookie (`LOGIN_INFO`/`SID`) being present. No session
  found ⇒ the button says "No sign-in detected".
- Progress is pushed to the renderer over `login:status`
  (`launching`/`waiting`/`importing`/`done`/`failed`); the button owns the copy.
- On success the embedded view reloads `HOME` so the session takes effect.

**Manual fallback — the CLI importer.** Same install path, reading an existing
browser profile directly:
```
miru --import-session ~/.config/BraveSoftware/Brave-Browser/Default
```
Close that browser first (it locks the cookie DB). The reader is chosen
automatically: `read-cookies-chromium.mjs` for Brave/Chrome/Vivaldi/Edge,
`read-cookies.mjs` for Firefox/Zen/LibreWolf. v11 (keyring) needs an unlocked
login keyring + libsecret.

Both paths funnel through the shared `readCookiesFromProfile()` +
`installCookies()`. **Install cookies via the Chromium cookie API, never by
writing the SQLite file** — a raw file write gets the youtube cookies rejected
and deleted by YouTube on first load (learned the hard way). Re-run either path
when Google logs you out.

**Cross-platform notes (login helper):**
- The reader runs through miru's own binary (`process.execPath` +
  `ELECTRON_RUN_AS_NODE=1`), not a system `node` — so it works on a Windows box
  with no Node installed. Don't switch it back to `spawn('node', …)`.
- `findBrowser()` is platform-aware: PATH scan on Linux, Program Files /
  LocalAppData on Windows, /Applications on macOS. Chromium family is preferred.
- Cookie decryption by platform, all in `read-cookies-chromium.mjs`:
  Linux v10 (constant "peanuts") / v11 (keyring via secret-tool); **Windows v10
  = AES-256-GCM with a DPAPI-unwrapped key** (`windowsKey()` shells out to
  PowerShell `ProtectedData.Unprotect`). Windows **v20 (app-bound, Chrome 127+)
  cannot be read by any other app** — the reader detects it and tells you to
  use Brave/Chromium for the login window instead. macOS (Keychain) is not
  implemented.
- **Windows path is untested** — it was written and deployed from the Linux box,
  which cannot run Windows crypto. Verify on the Windows partition; the likely
  failure is v20 app-bound cookies (use Brave/Chromium there) or a DPAPI/
  PowerShell hiccup.

**Deploying to the packaged apps:** packaged builds (e.g. `miru-{linux,win32}-x64`) can run
from `resources/app/` (a plain folder) with the original bundle kept as
`resources/app.asar.orig`. Neither binary has the asar-integrity fuse, so
redeploy by copying the source folder over `resources/app/` — do **not** repack
an asar. To revert a build, delete `resources/app/` and rename
`app.asar.orig` back to `app.asar`.

Chromium cookies are encrypted; the reader handles v10 (constant key), v11
(key from the login keyring via `secret-tool`, needs libsecret + unlocked
keyring) and the Chrome >= 130 host-hash plaintext prefix.

Verified working (via `--selftest`, see below):
- in-stream ad descriptors stripped: 28 pruned on one watch page
- theme applies on live YouTube — tokens override, masthead hidden
- Focus on: 14/15 cards hidden on a "minecraft funny moments" search, right categories
- Focus off: 0 hidden, all cards kept — no over-filtering
- Shorts shelves hidden with Focus off; sidebar live-counted 10 on the home feed
- per-card ✕ block button attaches to every visible card (needed a broader
  CHANNEL_SEL for watch-page lockups — was 0/22 there before)
- session importer, both readers, against synthetic profiles (never a real one):
  Firefox plaintext; Chromium v10, v10-with-host-prefix, and legacy unencrypted
- design pass: violet-on-black palette, sectioned sidebar, segmented Feed switch

Not yet verified:
- actual video playback
- how the theme holds up on the watch page and with a logged-in feed

Not done:
- no packaging: no `.desktop` entry, no icon, no build step
- LLM tier is written and wired but never exercised — no server was running

## Redesigning the look
The visual layer can be handed to another designer or model. The DOM contract to keep: (`shell.js` queries by
ID) and the functional CSS in `filter.css` that must not be touched.

It also sets out the three tiers of control over the embedded page, which is
worth knowing generally: **Tier 1** recolour via `--yt-spec-*` tokens; **Tier 2**
real layout change in pure CSS (`order`, re-declared grids, `:has()`) — far more
capable than it sounds and where most ambition should live; **Tier 3** actual DOM
work from `preload/youtube.cjs`, which already injects the per-card ✕ button, so
new sections and hero banners are genuinely possible. Tier 3 rule: **mirror,
don't move** — read data off YouTube's cards, render your own element, hide the
original. Reparenting YouTube's nodes loses against its Polymer re-render and
breaks lazy loading.
Hand over: that brief + `renderer/index.html` + `renderer/shell.css` +
`inject/theme.css` + `inject/filter.css`, plus `renderer/shell.js` as read-only
reference. Update it if the contract changes.

## Dev flags
```
npm run selftest          # prints JSON: did the CSS apply, what got filtered, ads pruned
npm start -- --shot       # writes miru-chrome.png (app UI only, never the desktop)
npm run import-session -- <firefox-profile-dir>
```
`MIRU_TEST_URL`, `MIRU_TEST_FOCUS=1`, `MIRU_TEST_WAIT`, `MIRU_SHOT_DIR` tune them.
`--selftest` with `MIRU_TEST_FOCUS=1` writes `focus: true` into settings.json — reset it after.
