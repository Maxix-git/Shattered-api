// POST /v1/heartbeat — periodic server presence from the plugin.
// Not idempotent by design: every beat is a fresh snapshot row.
import crypto from 'node:crypto';

function safeEq(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function intIn(v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi; }

export default async function heartbeatRoutes(app) {
  app.post('/v1/heartbeat', async (req, reply) => {
    const secret = process.env.PLUGIN_SHARED_SECRET;
    if (!secret || !safeEq(req.headers['x-plugin-secret'], secret)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const b = req.body ?? {};
    if (!intIn(b.online_players, 0, 10000) || !intIn(b.max_players, 0, 10000)) {
      return reply.code(400).send({ error: 'online_players and max_players must be integers 0-10000' });
    }
    const tps = Number(b.tps);
    if (!Number.isFinite(tps) || tps < 0 || tps > 21) {
      return reply.code(400).send({ error: 'tps must be a number 0-21' });
    }
    const motd = typeof b.motd === 'string' ? b.motd.slice(0, 256) : '';
    const version = typeof b.version === 'string' ? b.version.slice(0, 64) : '';
    await app.pg.query(
      `INSERT INTO server_status (online_players, max_players, tps, motd, version)
       VALUES ($1, $2, $3, $4, $5)`,
      [b.online_players, b.max_players, tps, motd, version]);
    return { accepted: true };
  });
}
