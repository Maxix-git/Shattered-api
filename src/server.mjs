// Shattered SMP API — plugin ingestion + public reads.
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

app.get('/health', async () => {
  let db = 'down';
  try { await pool.query('SELECT 1'); db = 'up'; } catch {}
  return { status: 'ok', db, site: process.env.NEXT_PUBLIC_SITE_NAME ?? 'Shattered SMP' };
});

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: '0.0.0.0' }).then(() =>
  console.log(`Shattered API on :${port}`));
