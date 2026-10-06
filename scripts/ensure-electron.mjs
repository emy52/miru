// npm 12 blocks install scripts and extract-zip can silently bail, leaving a
// broken Electron. Run before start: verify the binary, repair it if needed.
import { existsSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
let dir;
try { dir = path.dirname(require.resolve('electron/package.json')); }
catch { console.error('electron is not installed — run `npm install` first.'); process.exit(1); }

const exe = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? null : 'electron';
const ok = () => exe && existsSync(path.join(dir, 'dist', exe)) && existsSync(path.join(dir, 'path.txt'));
if (ok()) process.exit(0);

console.log('Electron binary missing — repairing…');
try { execFileSync(process.execPath, [path.join(dir, 'install.js')], { stdio: 'inherit' }); } catch {}
if (!ok()) {
  const cache = process.env.ELECTRON_CACHE || path.join(os.homedir(), '.cache', 'electron');
  const zips = [];
  const walk = (d) => { try { for (const f of readdirSync(d)) { const p = path.join(d, f); statSync(p).isDirectory() ? walk(p) : /^electron-v.*\.zip$/.test(f) && zips.push(p); } } catch {} };
  walk(cache);
  const zip = zips.sort().pop();
  if (zip) {
    for (const tool of [['tar', ['-xf', zip, '-C', path.join(dir, 'dist')]], ['bsdtar', ['-xf', zip, '-C', path.join(dir, 'dist')]], ['unzip', ['-oq', zip, '-d', path.join(dir, 'dist')]]]) {
      try { execFileSync('mkdir', ['-p', path.join(dir, 'dist')]); execFileSync(tool[0], tool[1], { stdio: 'inherit' }); writeFileSync(path.join(dir, 'path.txt'), exe); if (ok()) break; } catch {}
    }
  }
}
if (!ok()) { console.error('Could not repair Electron. See HANDOFF.md ("npm 12 blocks postinstall").'); process.exit(1); }
