// Simple forward-only migration runner.
// Applies every .sql in migrations/ that hasn't run yet, tracked in schema_migrations.
import './load-env.mjs'; // must be first — loads .env before we read DATABASE_URL
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }

const client = new pg.Client({ connectionString: url });
await client.connect();

await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

for (const file of files) {
  if (applied.has(file)) { console.log(`skip  ${file} (already applied)`); continue; }
  const sql = readFileSync(path.join(dir, file), 'utf8');
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log(`ok    ${file}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`FAIL  ${file}: ${e.message}`);
    process.exitCode = 1;
    break;
  }
}
await client.end();
