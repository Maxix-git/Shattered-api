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
    const regName = p.rows[0]?.username;
    if (regName) {
      // Register the MC name to this Discord account (offline-auth name lock).
      await app.pg.query(
        `INSERT INTO name_registry (mc_name, auth_type, discord_id) VALUES ($1, 'discord', $2)
         ON CONFLICT (mc_name) DO NOTHING`, [regName, discordId]);
      await app.pg.query(`UPDATE players SET in_limbo = false WHERE lower(username) = lower($1)`, [regName]);
    }
    return { linked: true, username: p.rows[0]?.username ?? 'player' };
  });

  // ---- new-feature endpoints for the website features (factions, bounties,
  // ---- community wall, notifications). Linked = Discord account connected
  // ---- to a Minecraft player via /link.

  function honorOf(kills, longest, playtimeSec, claims) {
    const hours = Math.floor((playtimeSec || 0) / 3600);
    return (kills || 0) * 2 + (longest || 0) * 5 + hours * 3 + (claims || 0) * 50;
  }

  async function requireLink(discordId) {
    const q = await app.pg.query(`
      SELECT p.id AS player_id, p.username,
             s.kills, s.deaths, s.kill_streak, s.longest_streak, s.playtime_seconds, p.first_join
      FROM discord_links dl
      JOIN players p ON p.id = dl.player_id
      LEFT JOIN player_stats s ON s.player_id = p.id
      WHERE dl.discord_id = $1`, [discordId]);
    if (!q.rows.length) return null;
    const r = q.rows[0];
    const claims = await app.pg.query(
      `SELECT count(*) AS c FROM bounties WHERE claimed_by = $1`, [discordId]);
    return {
      playerId: r.player_id, username: r.username,
      stats: {
        kills: r.kills || 0, deaths: r.deaths || 0,
        streak: r.kill_streak || 0, bestStreak: r.longest_streak || 0,
        hours: Math.floor((r.playtime_seconds || 0) / 3600),
        honor: honorOf(r.kills, r.longest_streak, r.playtime_seconds, claims.rows[0]?.c || 0),
      },
    };
  }

  app.get('/v1/bot/me', async (req, reply) => {
    const did = String(req.query?.discord_id ?? '');
    if (!/^\d{2,25}$/.test(did)) return reply.code(400).send({ error: 'discord_id required' });
    const link = await requireLink(did);
    if (!link) return { linked: false };
    const fac = await app.pg.query(`
      SELECT f.name, f.tag, f.description, fm.role
      FROM faction_members fm JOIN factions f ON f.id = fm.faction_id
      WHERE fm.discord_id = $1`, [did]);
    const notifs = await app.pg.query(`
      SELECT id::text, kind, body, created_at FROM notifications
      WHERE discord_id = $1 AND read_at IS NULL ORDER BY created_at DESC LIMIT 5`, [did]);
    const donorQ = await app.pg.query(`
      SELECT COALESCE(extract(epoch from max(d.created_at) + interval '30 days'), 0)::bigint AS until
      FROM donations d
      WHERE (d.discord_id = $1)
         OR (d.mc_name IS NOT NULL AND d.mc_name = (SELECT p.username FROM discord_links dl
              JOIN players p ON p.id = dl.player_id WHERE dl.discord_id = $1))`, [did]);
    const donorUntil = Number(donorQ.rows[0]?.until || 0);
    return {
      linked: true, mcName: link.username, stats: link.stats, donorUntil,
      faction: fac.rows[0] ? {
        name: fac.rows[0].name, tag: fac.rows[0].tag,
        description: fac.rows[0].description,
        role: fac.rows[0].role, isOwner: fac.rows[0].role === 'owner',
      } : null,
      notifications: notifs.rows.map(r => ({
        id: r.id, kind: r.kind, body: r.body, created_at: r.created_at,
      })),
    };
  });

  app.get('/v1/bot/factions', async () => {
    const { rows } = await app.pg.query(`
      SELECT f.name, f.tag, f.description,
             count(*) AS members,
             coalesce(sum(ps.kills), 0) AS kills
      FROM factions f
      LEFT JOIN faction_members fm ON fm.faction_id = f.id
      LEFT JOIN discord_links dl ON dl.discord_id = fm.discord_id
      LEFT JOIN player_stats ps ON ps.player_id = dl.player_id
      GROUP BY f.id ORDER BY count(*) DESC, f.name LIMIT 15`);
    return { rows };
  });

  app.get('/v1/bot/bounties', async (req) => {
    const limit = intParam(req.query?.limit, 10, 1, 20);
    const { rows } = await app.pg.query(
      `SELECT id::text, target_username, poster_name, reward, created_at
       FROM bounties WHERE status = 'open'
       ORDER BY created_at DESC LIMIT $1`, [limit]);
    return { rows };
  });

  const lastBountyAt = new Map();
  app.post('/v1/bot/bounty', async (req, reply) => {
    const b = req.body ?? {};
    const did = typeof b.discord_id === 'string' ? b.discord_id : '';
    const target = typeof b.target === 'string' ? b.target.trim().slice(0, 16) : '';
    if (!/^\d{2,25}$/.test(did)) return reply.code(400).send({ error: 'discord_id required' });
    if (!target) return reply.code(400).send({ error: 'target required' });
    const link = await requireLink(did);
    if (!link) return reply.code(403).send({ error: 'link your account first: /link in-game, then /link here' });
    if (link.username.toLowerCase() === target.toLowerCase())
      return reply.code(400).send({ error: 'you cannot put a bounty on yourself' });
    const exists = await app.pg.query(
      `SELECT 1 FROM bounties WHERE lower(target_username) = lower($1) AND status = 'open'`,
      [target]);
    if (exists.rows.length) return reply.code(409).send({ error: `a bounty is already open on ${target}` });
    const last = lastBountyAt.get(did) ?? 0;
    if (Date.now() - last < 60_000) return reply.code(429).send({ error: 'one bounty per minute — slow down' });
    lastBountyAt.set(did, Date.now());
    const posterName = typeof b.poster_name === 'string' ? b.poster_name.slice(0, 32) : link.username;
    // Stat-weighted reward: dangerous targets cost more.
    const st = await app.pg.query(
      `SELECT p.username, s.kills, s.deaths, s.kill_streak, s.longest_streak, s.playtime_seconds
       FROM players p LEFT JOIN player_stats s ON s.player_id = p.id
       WHERE lower(p.username) = lower($1) LIMIT 1`, [target]);
    if (!st.rows.length) return reply.code(404).send({ error: `no player named ${target} on the server` });
    const r0 = st.rows[0];
    const hours = (Number(r0.playtime_seconds) || 0) / 3600;
    const kd = (Number(r0.kills) || 0) / Math.max(1, Number(r0.deaths) || 0);
    let reward = 100 + (Number(r0.kills) || 0) * 10
      + Math.max(0, (Number(r0.kills) || 0) - (Number(r0.deaths) || 0)) * 5
      + (Number(r0.kill_streak) || 0) * 15 + (Number(r0.longest_streak) || 0) * 5
      + hours * 3 + kd * 20;
    reward = Math.max(100, Math.min(2000, Math.round(reward / 10) * 10));
    await app.pg.query(
      `INSERT INTO bounties (target_username, poster_discord_id, poster_name, reward) VALUES ($1, $2, $3, $4)`,
      [r0.username, did, posterName, reward]);
    return { ok: true, target: r0.username, reward };
  });

  const lastWallAt = new Map();
  app.post('/v1/bot/wall', async (req, reply) => {
    const b = req.body ?? {};
    const did = typeof b.discord_id === 'string' ? b.discord_id : '';
    const body = typeof b.body === 'string' ? b.body.trim().slice(0, 2000) : '';
    if (!/^\d{2,25}$/.test(did)) return reply.code(400).send({ error: 'discord_id required' });
    if (body.length < 3) return reply.code(400).send({ error: 'write at least a few words' });
    const link = await requireLink(did);
    if (!link) return reply.code(403).send({ error: 'link your account first: /link in-game, then /link here' });
    const last = lastWallAt.get(did) ?? 0;
    if (Date.now() - last < 30_000) return reply.code(429).send({ error: 'slow down — 30s between wall posts' });
    lastWallAt.set(did, Date.now());
    const author = typeof b.author === 'string' ? b.author.slice(0, 32) : link.username;
    const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 80) : null;
    const category = ['Community', 'Trade', 'Help', 'Events'].includes(b.category) ? b.category : 'Community';
    const q = await app.pg.query(
      `INSERT INTO community_posts (discord_id, author, category, title, body)
       VALUES ($1, $2, $3, $4, $5) RETURNING id::text`, [did, author, category, title, body]);
    return { ok: true, id: q.rows[0].id, author };
  });

  app.post('/v1/bot/notifs_read', async (req, reply) => {
    const b = req.body ?? {};
    const did = typeof b.discord_id === 'string' ? b.discord_id : '';
    if (!/^\d{2,25}$/.test(did)) return reply.code(400).send({ error: 'discord_id required' });
    await app.pg.query(`UPDATE notifications SET read_at = now() WHERE discord_id = $1 AND read_at IS NULL`, [did]);
    return { ok: true };
  });


  // Bot /appeal — feeds the shared appeals table.
  app.post('/v1/bot/appeal', async (req, reply) => {
    const b = req.body ?? {};
    const did = typeof b.discord_id === 'string' ? b.discord_id.slice(0, 25) : '';
    if (!/^\d{2,25}$/.test(did)) return reply.code(400).send({ error: 'discord_id required' });
    const punishment = ['ban', 'mute', 'kick', 'warn'].includes(b.punishment) ? b.punishment : 'ban';
    const mcName = typeof b.mc_name === 'string' ? b.mc_name.slice(0, 16) : null;
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 1000) : '';
    if (!reason) return reply.code(400).send({ error: 'add a reason' });
    await app.pg.query(
      `INSERT INTO appeals (discord_id, punishment, mc_name, reason) VALUES ($1, $2, $3, $4)`,
      [did, punishment, mcName, reason]);
    return { ok: true };
  });
}
