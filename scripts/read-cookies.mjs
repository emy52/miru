/**
 * Reads YouTube/Google cookies out of a Firefox-family browser profile
 * (Firefox, Zen, LibreWolf, Waterfox) and prints them as JSON on stdout.
 *
 * You run this yourself, on your own machine, against your own profile, to move
 * your own logged-in session into miru. It exists because Google refuses
 * sign-in from any embedded browser, so miru cannot log you in directly.
 *
 * Deliberate constraints:
 *   - takes an explicit profile path; never searches for browser profiles
 *   - opens the cookie store read-only and never modifies it
 *   - only youtube.com / google.com hosts, not your whole cookie jar
 *   - prints to stdout, which is piped straight into miru's own process;
 *     nothing is written to disk and nothing leaves this machine
 *
 * Runs under system Node (needs node:sqlite, Node >= 22.5), not Electron's.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const profile = process.argv[2];

if (!profile) {
  console.error('usage: npm run import-session -- <firefox-profile-dir>');
  console.error('the profile dir is the one containing cookies.sqlite');
  process.exit(2);
}

const dbPath = path.join(profile, 'cookies.sqlite');

if (!fs.existsSync(dbPath)) {
  console.error(`no cookies.sqlite in ${profile}`);
  // Most people point at the browser root rather than a profile; help once.
  try {
    const candidates = fs
      .readdirSync(profile, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(profile, e.name, 'cookies.sqlite')))
      .map((e) => path.join(profile, e.name));
    if (candidates.length) {
      console.error('\nprofiles found underneath it:');
      for (const c of candidates) console.error(`  ${c}`);
    }
  } catch { /* not readable; the error above is enough */ }
  process.exit(2);
}

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
} catch (err) {
  console.error(`could not open cookie store: ${err.message}`);
  console.error('close the browser first — it holds a lock on this file');
  process.exit(1);
}

let rows;
try {
  rows = db
    .prepare(
      `SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite
       FROM moz_cookies
       WHERE host LIKE '%youtube.com' OR host LIKE '%google.com'`,
    )
    .all();
} finally {
  db.close();
}

process.stdout.write(JSON.stringify(rows));
console.error(`read ${rows.length} youtube/google cookies from ${path.basename(profile)}`);
