// Bot routes — server-to-server endpoints for the Discord bot.
// Auth: X-Bot-Secret header (BOT_SECRET env). Separate from
// INTERNAL_SECRET (website) and PLUGIN_SHARED_SECRET (Minecraft plugin)
// so each component holds only the secret it needs.
//
//  - GET  /v1/bot/status        — latest server heartbeat
//  - GET  /v1/bot/top           — leaderboard (metric= kills|deaths|streak|playtime)
//  - GET  /v1/bot/kills?since   — new kill rows for announcements
//  - GET  /v1/bot/sessions?since— new join/quit rows for announcements
//  - POST /v1/bot/link          — claim a /link code for a Discord user
import crypto from 'node:crypto';

const METRICS = {
  kills: 'kills',
  deaths: 'deaths',
  streak: 'kill_streak',
  playtime: 'playtime_seconds',
};

function safeEq(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function intParam(v, def, min, max) {
  const n = Number.parseInt(v ?? '', 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export default async function botRoutes(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/v1/bot/')) return;
    const secret = process.env.BOT_SECRET;
    if (!secret || !safeEq(req.headers['x-bot-secret'], secret)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/v1/bot/status', async () => {
    const { rows } = await app.pg.query(
      `SELECT online_players, max_players, tps, motd, version, recorded_at
       FROM server_status ORDER BY id DESC LIMIT 1`);
    if (!rows.length) return { online: false, stale: true };
    const r = rows[0];
    const age = (Date.now() - Date.parse(r.recorded_at)) / 1000;
    return {
      online: age < 120,
      online_players: r.online_players,
      max_players: r.max_players,
      tps: Math.round(r.tps * 10) / 10,
      motd: r.motd,
      version: r.version,
      recorded_at: r.recorded_at,
      stale: age >= 120,
    };
  });

  app.get('/v1/bot/top', async (req) => {
    const metric = METRICS[req.query?.metric] ?? 'kills';
    const limit = intParam(req.query?.limit, 10, 1, 25);
    const { rows } = await app.pg.query(
      `SELECT p.username, COALESCE(s.${metric}, 0) AS value
       FROM players p LEFT JOIN player_stats s ON s.player_id = p.id
       ORDER BY s.${metric} DESC NULLS LAST, p.last_seen DESC
       LIMIT $1`, [limit]);
    return { metric, rows };
  });

  app.get('/v1/bot/kills', async (req) => {
    if (req.query?.latest) {
      const { rows } = await app.pg.query(`SELECT COALESCE(MAX(id), 0) AS cursor FROM kill_events`);
      return { cursor: rows[0].cursor };
    }
    const since = intParam(req.query?.since, 0, 0, 2 ** 48);
    const limit = intParam(req.query?.limit, 20, 1, 50);
    const { rows } = await app.pg.query(
      `SELECT k.id, v.username AS victim, kl.username AS killer,
              k.cause, k.dimension, k.occurred_at
       FROM kill_events k
       JOIN players v ON v.id = k.victim_id
       LEFT JOIN players kl ON kl.id = k.killer_id
       WHERE k.id > $1
       ORDER BY k.id ASC LIMIT $2`, [since, limit]);
    return { rows, cursor: rows.length ? rows[rows.length - 1].id : since };
  });

  app.get('/v1/bot/sessions', async (req) => {
    if (req.query?.latest) {
      const { rows } = await app.pg.query(`SELECT COALESCE(MAX(id), 0) AS cursor FROM session_events`);
      return { cursor: rows[0].cursor };
    }
    const since = intParam(req.query?.since, 0, 0, 2 ** 48);
    const limit = intParam(req.query?.limit, 20, 1, 50);
    const { rows } = await app.pg.query(
      `SELECT id, type, username, session_seconds, occurred_at
       FROM session_events
       WHERE id > $1
       ORDER BY id ASC LIMIT $2`, [since, limit]);
    return { rows, cursor: rows.length ? rows[rows.length - 1].id : since };
  });

  app.post('/v1/bot/link', async (req, reply) => {
    const b = req.body ?? {};
    const discordId = typeof b.discord_id === 'string' ? b.discord_id : '';
    const discordName = typeof b.discord_username === 'string' ? b.discord_username.slice(0, 64) : '';
    const code = typeof b.code === 'string' ? b.code.trim().toUpperCase() : '';
    if (!/^\d{2,25}$/.test(discordId)) {
      return reply.code(400).send({ error: 'discord_id required' });
    }
    if (!/^[ACDEFGHJKLMNPQRTUVWXY346789]{6}$/.test(code)) {
      return reply.code(400).send({ error: 'enter the 6-character code from /link in-game' });
    }
    const res = await app.pg.query(
      `UPDATE link_codes SET claimed_at = now()
       WHERE code = $1 AND claimed_at IS NULL AND expires_at > now()
       RETURNING player_id`, [code]);
    if (!res.rows.length) return reply.code(404).send({ error: 'code invalid or expired' });
    const playerId = res.rows[0].player_id;
    await app.pg.query(
      `INSERT INTO discord_links (player_id, discord_id, discord_username)
       VALUES ($1, $2, $3)
       ON CONFLICT (player_id) DO UPDATE SET discord_id = EXCLUDED.discord_id,
         discord_username = EXCLUDED.discord_username, linked_at = now()`,
      [playerId, discordId, discordName]);
    const p = await app.pg.query(`SELECT username FROM players WHERE id = $1`, [playerId]);
    return { linked: true, username: p.rows[0]?.username ?? 'player' };
  });
}
