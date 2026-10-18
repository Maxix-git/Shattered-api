// Step 5: /link code system.
//  - POST /v1/link/code  (plugin secret auth) — player runs /link, gets a code
//  - POST /v1/link/claim (internal secret auth) — website server links Discord <-> player
import crypto from 'node:crypto';

function safeEq(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const CODE_TTL_MIN = 15;

function genCode() {
  // 6 chars from an unambiguous alphabet.
  const abc = 'ACDEFGHJKLMNPQRTUVWXY346789';
  let c = '';
  for (let i = 0; i < 6; i++) c += abc[crypto.randomInt(abc.length)];
  return c;
}

async function findPlayer(app, uuid, username) {
  const found = await app.pg.query(
    `SELECT id FROM players WHERE uuid = $1::uuid`, [uuid]);
  if (found.rows.length) return found.rows[0].id;
  const ins = await app.pg.query(
    `INSERT INTO players (uuid, username, edition) VALUES ($1::uuid, $2, 'java')
     ON CONFLICT (uuid) DO UPDATE SET username = EXCLUDED.username, updated_date = now()
     RETURNING id`, [uuid, username]);
  return ins.rows[0].id;
}

export default async function linkRoutes(app) {
  const secret = () => process.env.PLUGIN_SHARED_SECRET;

  // Plugin requests a link code for a player.
  app.post('/v1/link/code', async (req, reply) => {
    const sec = secret();
    if (!sec || !safeEq(req.headers['x-plugin-secret'], sec)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const b = req.body ?? {};
    const uuid = typeof b.player_uuid === 'string' ? b.player_uuid : '';
    const name = typeof b.player_name === 'string' ? b.player_name.slice(0, 32) : '';
    if (!/^[0-9a-f-]{36}$/i.test(uuid) || !name) {
      return reply.code(400).send({ error: 'player_uuid and player_name required' });
    }
    const playerId = await findPlayer(app, uuid, name);
    // Purge expired codes, then issue a fresh one (one live code per player).
    await app.pg.query(`DELETE FROM link_codes WHERE expires_at < now() OR player_id = $1`, [playerId]);
    const code = genCode();
    await app.pg.query(
      `INSERT INTO link_codes (code, player_id, expires_at)
       VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
      [code, playerId, String(CODE_TTL_MIN)]);
    return { code, expires_in_minutes: CODE_TTL_MIN,
      instructions: `Enter this code at the website's /link page within ${CODE_TTL_MIN} minutes.` };
  });

  // Claim: called server-to-server by the website (X-Internal-Secret auth),
  // which has already authenticated the Discord user via its own session.
  app.post('/v1/link/claim', async (req, reply) => {
    const internal = process.env.INTERNAL_SECRET;
    if (!internal || !safeEq(req.headers['x-internal-secret'], internal)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const s = { discord_id: req.body?.discord_id, discord_username: req.body?.discord_username ?? '' };
    if (typeof s.discord_id !== 'string' || !/^\d{2,25}$/.test(s.discord_id)) {
      return reply.code(400).send({ error: 'discord_id required' });
    }
    const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
    if (!/^[ACDEFGHJKLMNPQRTUVWXY346789]{6}$/.test(code)) {
      return reply.code(400).send({ error: 'enter the 6-character code from /link' });
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
      [playerId, s.discord_id, s.discord_username]);
    const p = await app.pg.query(`SELECT username FROM players WHERE id = $1`, [playerId]);
    return { linked: true, username: p.rows[0]?.username ?? 'player' };
  });
}
