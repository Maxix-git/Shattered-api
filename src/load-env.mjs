// Tiny .env loader (no dependency; ignores it if absent).
// MUST be imported FIRST in every entrypoint. Fully synchronous — no
// top-level await, so the module completes before the next import (which
// may read process.env at module level) is evaluated. Real environment
// (Render/Vercel dashboards) always wins — never overwrites existing env.
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const files = [
  path.join(process.cwd(), '.env'),
  path.join(here, '.env'),
  path.join(here, '../.env'),
];
const file = files.find((f) => { try { return fs.existsSync(f); } catch { return false; } });
if (file) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#') || process.env[m[1]] !== undefined) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
export const loadedFromFile = Boolean(file);
