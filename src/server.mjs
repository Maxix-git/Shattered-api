// Shattered SMP API — plugin ingestion + public reads.
// --- tiny .env loader (no dependency; ignores it if absent) ---
try {
  const __fs = await import("node:fs");
  const __path = await import("node:path");
  const __here = __path.dirname(new URL(import.meta.url).pathname);
  const __files = [__path.join(process.cwd(), ".env"), __path.join(__here, ".env"), __path.join(__here, "../.env")];
  const __file = __files.find((f) => { try { return __fs.existsSync(f); } catch { return false; } });
  if (__file) {
    for (const __line of __fs.readFileSync(__file, "utf8").split("\n")) {
      const __m = __line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!__m || __line.trim().startsWith("#") || process.env[__m[1]] !== undefined) continue;
      let __v = __m[2].trim();
      if ((__v.startsWith('"') && __v.endsWith('"')) || (__v.startsWith("'") && __v.endsWith("'"))) __v = __v.slice(1, -1);
      process.env[__m[1]] = __v;
    }
  }
} catch {}

import Fastify from 'fastify';
import pg from 'pg';
import ingestRoutes from './routes/ingest.mjs';

const app = Fastify({ logger: { level: process.env.NODE_ENV === 'production' ? 'warn' : 'info' } });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
app.decorate('pg', pool);

await app.register(ingestRoutes);
import heartbeatRoutes from './routes/heartbeat.mjs';
await app.register(heartbeatRoutes);
import publicRoutes from './routes/public.mjs';
await app.register(publicRoutes);
import assistantRoutes from './routes/assistant.mjs';
await app.register(assistantRoutes);
import linkRoutes from './routes/link.mjs';
await app.register(linkRoutes);
import botRoutes from './routes/bot.mjs';
await app.register(botRoutes);
import chatRoutes from './routes/chat.mjs';
await app.register(chatRoutes);
import siteRoutes from './routes/site.mjs';
await app.register(siteRoutes);

app.get('/health', async () => {
  let db = 'down';
  try { await pool.query('SELECT 1'); db = 'up'; } catch {}
  return { status: 'ok', db, site: process.env.NEXT_PUBLIC_SITE_NAME ?? 'Shattered SMP' };
});

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: '0.0.0.0' }).then(() =>
  console.log(`Shattered API on :${port}`));
