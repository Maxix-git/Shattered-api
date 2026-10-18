// Public read endpoints: search, profiles, kill history, leaderboards, status.
import crypto from 'node:crypto';

const METRICS = {
  kills: 'kills',
  deaths: 'deaths',
  kill_streak: 'kill_streak',
  longest_streak: 'longest_streak',
  playtime: 'playtime_seconds',
};

function intParam(v, def, min, max) {
  const n = Number.parseInt(v ?? '', 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function fmtSeconds(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Simple in-memory rate limit: 60 req/min per IP for public reads.
const hits = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [k, arr] of hits) hits.set(k, arr.filter(t => t > cutoff));
}, 30_000).unref();

export default async function publicRoutes(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/v1/players') && !req.url.startsWith('/v1/leaderboards') && !req.url.startsWith('/v1/status')) return;
    const key = req.ip;
    const now = Date.now();
    const arr = (hits.get(key) ?? []).filter(t => t > now - 60_000);
    if (arr.length >= 60) return reply.code(429).send({ error: 'too many requests' });
    arr.push(now);
    hits.set(key, arr);
  });

  // Player search / browse
  app.get('/v1/players', async (req) => {
    const limit = intParam(req.query?.limit, 20, 1, 50);
    const offset = intParam(req.query?.offset, 0, 0, 10000);
    const search = (req.query?.search ?? '').trim().slice(0, 32);
    const params = [limit, offset];
    if (search) params.push('%' + search.replace(/[%_]/g, '') + '%');
    const { rows } = await app.pg.query(
      `SELECT p.username, p.edition, p.first_join, p.last_seen,
              COALESCE(s.kills, 0) AS kills, COALESCE(s.deaths, 0) AS deaths,
              COALESCE(s.kill_streak, 0) AS kill_streak,
              COALESCE(s.longest_streak, 0) AS longest_streak,
              COALESCE(s.playtime_seconds, 0)::int AS playtime_seconds
       FROM players p LEFT JOIN player_stats s ON s.player_id = p.id
       ${search ? 'WHERE lower(p.username) LIKE lower($3)' : ''}
       ORDER BY p.last_seen DESC NULLS LAST
       LIMIT $1 OFFSET $2`, params);
    return {
      count: rows.length,
      players: rows.map(r => ({ ...r, playtime_human: fmtSeconds(r.playtime_seconds) })),
    };
  });

  // Player profile with combat history
  app.get('/v1/players/:username', async (req, reply) => {
    const username = (req.params?.username ?? '').slice(0, 32);
    const { rows: pRows } = await app.pg.query(
      `SELECT p.id, p.uuid, p.username, p.edition, p.first_join, p.last_seen,
              COALESCE(s.kills, 0) AS kills, COALESCE(s.deaths, 0) AS deaths,
              COALESCE(s.kill_streak, 0) AS kill_streak,
              COALESCE(s.longest_streak, 0) AS longest_streak,
              COALESCE(s.playtime_seconds, 0)::int AS playtime_seconds
       FROM players p LEFT JOIN player_stats s ON s.player_id = p.id
       WHERE lower(p.username) = lower($1)`, [username]);
    if (pRows.length === 0) return reply.code(404).send({ error: 'player not found' });
    const p = pRows[0];
    const { rows: kills } = await app.pg.query(
      `SELECT k.occurred_at, k.cause, k.dimension,
              v.username AS victim, kl.username AS killer
       FROM kill_events k
       JOIN players v ON v.id = k.victim_id
       LEFT JOIN players kl ON kl.id = k.killer_id
       WHERE k.victim_id = $1 OR k.killer_id = $1
       ORDER BY k.occurred_at DESC LIMIT 25`, [p.id]);
    return {
      username: p.username, uuid: p.uuid, edition: p.edition,
      first_join: p.first_join, last_seen: p.last_seen,
      stats: {
        kills: p.kills, deaths: p.deaths,
        kill_streak: p.kill_streak, longest_streak: p.longest_streak,
        playtime_seconds: p.playtime_seconds, playtime_human: fmtSeconds(p.playtime_seconds),
        kd_ratio: p.deaths === 0 ? Number(p.kills.toFixed ? p.kills : p.kills) : Math.round((p.kills / p.deaths) * 100) / 100,
      },
      recent_combat: kills,
    };
  });

  // Leaderboards
  app.get('/v1/leaderboards/:metric', async (req, reply) => {
    const col = METRICS[req.params?.metric];
    if (!col) return reply.code(400).send({ error: 'unknown metric', valid: Object.keys(METRICS) });
    const limit = intParam(req.query?.limit, 10, 1, 50);
    const offset = intParam(req.query?.offset, 0, 0, 10000);
    const { rows } = await app.pg.query(
      `SELECT p.username, p.edition, s.${col}::int AS value
       FROM player_stats s JOIN players p ON p.id = s.player_id
       WHERE s.${col} > 0
       ORDER BY s.${col} DESC, p.username ASC
       LIMIT $1 OFFSET $2`, [limit, offset]);
    return {
      metric: req.params.metric,
      entries: rows.map((r, i) => ({
        rank: offset + i + 1,
        username: r.username, edition: r.edition,
        value: r.value,
        value_human: col === 'playtime_seconds' ? fmtSeconds(r.value) : r.value,
      })),
    };
  });

  // Server status — honest labeling: what's config vs what's measured
  app.get('/v1/status', async () => {
    const [players, beat] = await Promise.all([
      app.pg.query(`SELECT count(*)::int AS tracked_players, max(last_seen) AS latest_seen FROM players`),
      app.pg.query(`SELECT online_players, max_players, tps, motd, version,
                            EXTRACT(EPOCH FROM (now() - recorded_at))::int AS age_seconds
                     FROM server_status ORDER BY recorded_at DESC LIMIT 1`),
    ]);
    const b = beat.rows[0];
    const live = b && b.age_seconds <= 90;
    return {
      site: process.env.NEXT_PUBLIC_SITE_NAME ?? 'Shattered SMP',
      minecraft_version: b?.version || process.env.MC_VERSION || 'unknown',
      java_address: process.env.JAVA_ADDRESS ?? null,
      bedrock_address: process.env.BEDROCK_ADDRESS ?? null,
      tracked_players: players.rows[0].tracked_players,
      last_event_seen: players.rows[0].latest_seen,
      data_freshness: live ? 'live' : 'historical',
      live: live ? {
        online_players: b.online_players,
        max_players: b.max_players,
        tps: Math.round(b.tps * 10) / 10,
        motd: b.motd,
        heartbeat_age_seconds: b.age_seconds,
      } : null,
    };
  });
}
