/**
 * Reads YouTube/Google cookies out of a Chromium-family browser profile
 * (Brave, Chrome, Chromium, Vivaldi, Edge) and prints them as JSON on stdout.
 *
 * You run this yourself, on your own machine, against your own profile, to move
 * your own logged-in session into miru. It exists because Google refuses
 * sign-in from any embedded browser, so miru cannot log you in directly.
 *
 * Chromium encrypts cookie values, unlike Firefox. On Linux:
 *   v10 prefix -> key derived from the constant "peanuts" (no keyring in use)
 *   v11 prefix -> key derived from a password held in the login keyring
 * Both use PBKDF2-SHA1(salt="saltysalt", 1 iteration, 16 bytes) and AES-128-CBC
 * with an all-spaces IV. These constants are Chromium's, not secrets.
 *
 * Same constraints as the Firefox reader:
 *   - takes an explicit profile path; never searches for browser profiles
 *   - opens the cookie store read-only and never modifies it
 *   - only youtube.com / google.com hosts, not your whole cookie jar
 *   - prints to stdout, piped into miru's own process; nothing hits disk
 */
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const SALT = 'saltysalt';
const IV = Buffer.alloc(16, ' ');
const KEY_LEN = 16;

const profile = process.argv[2];

if (!profile) {
  console.error('usage: npm run import-session -- <chromium-profile-dir>');
  console.error('e.g. ~/.config/BraveSoftware/Brave-Browser/Default');
  process.exit(2);
}

const dbPath = path.join(profile, 'Cookies');

if (!fs.existsSync(dbPath)) {
  console.error(`no Cookies database in ${profile}`);
  try {
    const found = fs
      .readdirSync(profile, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(profile, e.name, 'Cookies')))
      .map((e) => path.join(profile, e.name));
    if (found.length) {
      console.error('\nprofiles found underneath it:');
      for (const f of found) console.error(`  ${f}`);
    }
  } catch { /* not readable; message above is enough */ }
  process.exit(2);
}

/** Ask the login keyring for the browser's "Safe Storage" password (v11 cookies). */
function keyringPassword() {
  const attempts = [
    ['application', 'brave'],
    ['application', 'chrome'],
    ['application', 'chromium'],
  ];
  for (const [attr, value] of attempts) {
    try {
      const out = execFileSync('secret-tool', ['lookup', attr, value], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (out) return out.trim();
    } catch { /* not this one, or secret-tool absent */ }
  }
  return null;
}

const keyCache = new Map();
function keyFor(password) {
  if (!keyCache.has(password)) {
    keyCache.set(password, crypto.pbkdf2Sync(password, SALT, 1, KEY_LEN, 'sha1'));
  }
  return keyCache.get(password);
}

let warnedNoKeyring = false;
let warnedNoWinKey = false;
let warnedAppBound = false;

/**
 * Windows key: os_crypt.encrypted_key in Local State, unwrapped with DPAPI
 * (CurrentUser scope, so it only works as the same Windows user that wrote it).
 * We shell out to PowerShell's ProtectedData.Unprotect rather than pull in a
 * native addon. Returns the 32-byte AES-256-GCM key, or null.
 */
let winKeyCache;
function windowsKey() {
  if (winKeyCache !== undefined) return winKeyCache;
  winKeyCache = null;
  let dir = profile;
  let localState = null;
  for (let i = 0; i < 3 && dir; i += 1) {
    const p = path.join(dir, 'Local State');
    if (fs.existsSync(p)) { localState = p; break; }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (!localState) return winKeyCache;
  let encKeyB64;
  try { encKeyB64 = JSON.parse(fs.readFileSync(localState, 'utf8')).os_crypt?.encrypted_key; }
  catch { return winKeyCache; }
  if (!encKeyB64) return winKeyCache;
  let blob = Buffer.from(encKeyB64, 'base64');
  if (blob.subarray(0, 5).toString('latin1') === 'DPAPI') blob = blob.subarray(5);
  const ps =
    'Add-Type -AssemblyName System.Security; '
    + `$b=[Convert]::FromBase64String('${blob.toString('base64')}'); `
    + "$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); "
    + '[Convert]::ToBase64String($k)';
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    const key = Buffer.from(out.trim(), 'base64');
    winKeyCache = key.length === 32 ? key : null;
  } catch { /* powershell missing or DPAPI refused */ }
  return winKeyCache;
}

function decryptWindows(buf, hostKey) {
  const version = buf.subarray(0, 3).toString('latin1');
  // v20 = app-bound encryption (Chrome 127+): the key is held by Chrome's own
  // elevation service and cannot be read by another process. No workaround.
  if (version === 'v20') {
    if (!warnedAppBound) {
      console.error('warning: this browser wrote app-bound (v20) cookies, which no other');
      console.error('         app can decrypt. Try Brave or Chromium for the login window.');
      warnedAppBound = true;
    }
    return null;
  }
  if (version !== 'v10') return buf.toString('utf8'); // legacy/unencrypted
  const key = windowsKey();
  if (!key) {
    if (!warnedNoWinKey) {
      console.error('warning: could not unwrap the Windows cookie key via DPAPI.');
      warnedNoWinKey = true;
    }
    return null;
  }
  try {
    // v10 layout: "v10" | 12-byte nonce | ciphertext | 16-byte GCM tag.
    const nonce = buf.subarray(3, 15);
    const tag = buf.subarray(buf.length - 16);
    const ciphertext = buf.subarray(15, buf.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    let out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    // Chrome >= 130 also prefixes the plaintext with a 32-byte SHA-256 of the host.
    if (out.length > 32) {
      const expected = crypto.createHash('sha256').update(hostKey).digest();
      if (out.subarray(0, 32).equals(expected)) out = out.subarray(32);
    }
    return out.toString('utf8');
  } catch {
    return null;
  }
}

function decrypt(buf, hostKey) {
  if (!buf || buf.length === 0) return '';
  if (process.platform === 'win32') return decryptWindows(buf, hostKey);
  const version = buf.subarray(0, 3).toString('latin1');

  // Unencrypted (rare, older profiles).
  if (version !== 'v10' && version !== 'v11') return buf.toString('utf8');

  let password = 'peanuts';
  if (version === 'v11') {
    const fromKeyring = keyringPassword();
    if (!fromKeyring) {
      if (!warnedNoKeyring) {
        console.error('warning: v11 cookies need the login keyring, but secret-tool');
        console.error('         returned nothing. Install libsecret and unlock your keyring.');
        warnedNoKeyring = true;
      }
      return null;
    }
    password = fromKeyring;
  }

  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', keyFor(password), IV);
    decipher.setAutoPadding(false);
    let out = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);

    // Strip PKCS#7 padding.
    const pad = out[out.length - 1];
    if (pad > 0 && pad <= 16 && pad <= out.length) out = out.subarray(0, out.length - pad);

    // Chrome >= 130 prefixes the plaintext with a 32-byte SHA-256 of the host.
    if (out.length > 32) {
      const expected = crypto.createHash('sha256').update(hostKey).digest();
      if (out.subarray(0, 32).equals(expected)) out = out.subarray(32);
    }

    return out.toString('utf8');
  } catch {
    return null;
  }
}

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
} catch (err) {
  console.error(`could not open cookie store: ${err.message}`);
  console.error('close the browser first — it holds a lock on this file');
  process.exit(1);
}

let raw;
try {
  const stmt = db.prepare(
    `SELECT host_key, name, encrypted_value, value, path, expires_utc,
            is_secure, is_httponly, samesite
     FROM cookies
     WHERE host_key LIKE '%youtube.com' OR host_key LIKE '%google.com'`,
  );
  // expires_utc is microseconds since 1601 (~1.3e16) — past Number.MAX_SAFE_INTEGER,
  // so node:sqlite throws unless integers come back as BigInt.
  stmt.setReadBigInts(true);
  raw = stmt.all();
} finally {
  db.close();
}

// Chromium stores expiry as microseconds since 1601-01-01.
const CHROME_EPOCH_OFFSET = 11644473600n;
const toUnix = (v) => {
  const micros = typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v) || 0));
  if (micros <= 0n) return 0;
  return Number(micros / 1000000n - CHROME_EPOCH_OFFSET);
};
const num = (v) => Number(v ?? 0);
const SAME_SITE = { '-1': 1, 0: 0, 1: 1, 2: 2 }; // -> firefox-style codes the importer expects

let failed = 0;
const rows = [];

for (const c of raw) {
  const value = c.value || decrypt(Buffer.from(c.encrypted_value), c.host_key);
  if (value === null) {
    failed += 1;
    continue;
  }
  rows.push({
    host: c.host_key,
    name: c.name,
    value,
    path: c.path,
    expiry: toUnix(c.expires_utc),
    isSecure: num(c.is_secure),
    isHttpOnly: num(c.is_httponly),
    sameSite: SAME_SITE[String(num(c.samesite))] ?? 1,
  });
}

process.stdout.write(JSON.stringify(rows));
console.error(
  `read ${rows.length} youtube/google cookies from ${path.basename(profile)}` +
    (failed ? ` (${failed} could not be decrypted)` : ''),
);
