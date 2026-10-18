// POST /v1/events — plugin ingestion. Shared-secret auth, validated, idempotent.
import crypto from 'node:crypto';

const TYPES = new Set(['player_join', 'player_quit', 'player_death']);
const DIMS = new Set(['overworld', 'nether', 'the_end']);
const EDITIONS = new Set(['java', 'bedrock']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeEq(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function validEvent(e) {
  if (!e || !TYPES.has(e.type)) return false;
  if (typeof e.event_id !== 'string' || !e.event_id || e.event_id.length > 64) return false;
  if (typeof e.uuid !== 'string' || !UUID_RE.test(e.uuid)) return false;
  if (typeof e.username !== 'string' || e.username.length < 2 || e.username.length > 32) return false;
  if (!EDITIONS.has(e.edition)) return false;
  const t = Date.parse(e.occurred_at);
  if (!Number.isFinite(t)) return false;
  if (e.type === 'player_death') {
    if (!DIMS.has(e.dimension)) return false;
    if (typeof e.cause !== 'string' || e.cause.length > 64) return false;
    if (![e.x, e.y, e.z].every(Number.isInteger)) return false;
    if (e.killer_uuid !== undefined) {
      if (!UUID_RE.test(e.killer_uuid)) return false;
      if (typeof e.killer_name !== 'string' || e.killer_name.length > 32) return false;
      if (!EDITIONS.has(e.killer_edition)) return false;
    }
  }
  if (e.type === 'player_quit') {
    if (!Number.isFinite(e.session_seconds) || e.session_seconds < 0 || e.session_seconds > 86400 * 3) return false;
  }
  return true;
}

async function upsertPlayer(client, uuid, username, edition, seenAt) {
  const { rows } = await client.query(
    `INSERT INTO players (uuid, username, edition, last_seen)
     VALUES ($1, $2, $3, COALESCE($4, now()))
     ON CONFLICT (uuid) DO UPDATE SET
       username = EXCLUDED.username,
       last_seen = GREATEST(players.last_seen, COALESCE(EXCLUDED.last_seen, players.last_seen))
     RETURNING id`,
    [uuid, username, edition, seenAt ?? null]);
  return rows[0].id;
}

async function ensureStats(client, playerId) {
  await client.query(
    `INSERT INTO player_stats (player_id) VALUES ($1) ON CONFLICT (player_id) DO NOTHING`,
    [playerId]);
}

export default async function ingestRoutes(app) {
  app.post('/v1/events', async (req, reply) => {
    const secret = process.env.PLUGIN_SHARED_SECRET;
    if (!secret || !safeEq(req.headers['x-plugin-secret'], secret)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const events = req.body?.events;
    if (!Array.isArray(events) || events.length === 0 || events.length > 100) {
      return reply.code(400).send({ error: 'events must be a non-empty array of at most 100' });
    }
    for (const e of events) {
      if (!validEvent(e)) return reply.code(422).send({ error: 'invalid event', event_id: e?.event_id ?? null });
    }

    let accepted = 0, duplicates = 0;
    const client = await app.pg.connect();
    try {
      await client.query('BEGIN');
      for (const e of events) {
        if (e.type === 'player_join') {
          await upsertPlayer(client, e.uuid, e.username, e.edition, e.occurred_at);
          await client.query(
            `INSERT INTO session_events (event_id, type, uuid, username, occurred_at)
             VALUES ($1, 'player_join', $2, $3, $4)
             ON CONFLICT (event_id) DO NOTHING`,
            [e.event_id, e.uuid, e.username, e.occurred_at]);
          accepted++;
        } else if (e.type === 'player_quit') {
          const id = await upsertPlayer(client, e.uuid, e.username, e.edition, e.occurred_at);
          await ensureStats(client, id);
          await client.query(
            `UPDATE player_stats SET playtime_seconds = player_stats.playtime_seconds + $2
             WHERE player_id = $1`,
            [id, Math.floor(e.session_seconds)]);
          await client.query(
            `INSERT INTO session_events (event_id, type, uuid, username, session_seconds, occurred_at)
             VALUES ($1, 'player_quit', $2, $3, $4, $5)
             ON CONFLICT (event_id) DO NOTHING`,
            [e.event_id, e.uuid, e.username, Math.floor(e.session_seconds), e.occurred_at]);
          accepted++;
        } else { // player_death
          const victimId = await upsertPlayer(client, e.uuid, e.username, e.edition, e.occurred_at);
          let killerId = null;
          if (e.killer_uuid) {
            killerId = await upsertPlayer(client, e.killer_uuid, e.killer_name, e.killer_edition, e.occurred_at);
          }
          const ins = await client.query(
            `INSERT INTO kill_events (event_id, victim_id, killer_id, cause, dimension, x, y, z, occurred_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (event_id) DO NOTHING`,
            [e.event_id, victimId, killerId, e.cause, e.dimension, e.x, e.y, e.z, e.occurred_at]);
          if (ins.rowCount === 1) {
            // Only mutate stats when the ledger row is genuinely new.
            await ensureStats(client, victimId);
            await client.query(
              `UPDATE player_stats SET deaths = deaths + 1, kill_streak = 0 WHERE player_id = $1`,
              [victimId]);
            if (killerId) {
              await ensureStats(client, killerId);
              await client.query(
                `UPDATE player_stats
                 SET kills = kills + 1,
                     kill_streak = kill_streak + 1,
                     longest_streak = GREATEST(longest_streak, kill_streak + 1)
                 WHERE player_id = $1`,
                [killerId]);
            }
            accepted++;
          } else {
            duplicates++;
          }
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      app.log.error({ err }, 'ingest failed');
      return reply.code(500).send({ error: 'ingest failed' });
    } finally {
      client.release();
    }
    return { accepted, duplicates };
  });

  app.get('/v1/killfeed', async (req) => {
    const limit = Math.min(50, Math.max(1, Number(req.query?.limit ?? 20)));
    const { rows } = await app.pg.query(
      `SELECT k.occurred_at, k.cause, k.dimension, k.x, k.y, k.z,
              v.username AS victim, v.edition AS victim_edition,
              kl.username AS killer, kl.edition AS killer_edition
       FROM kill_events k
       JOIN players v ON v.id = k.victim_id
       LEFT JOIN players kl ON kl.id = k.killer_id
       ORDER BY k.occurred_at DESC
       LIMIT $1`, [limit]);
    return rows;
  });
}
