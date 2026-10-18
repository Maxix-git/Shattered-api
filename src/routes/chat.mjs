// Chat bridge + auth registry routes.
//  - Plugin (X-Plugin-Secret): chat ingest/out, registry check/status, bounty, releases.
//  - Bot (X-Bot-Secret): chat in/out, birthdays.
import crypto from 'node:crypto';

function safeEq(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const MAX_BODY = 256;

function cleanMessages(arr, { authorMax = 32 } = {}) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(m => m && typeof m.body === 'string' && m.body.trim())
    .slice(0, 25)
    .map(m => ({
      name: String(m.name ?? '').slice(0, authorMax) || 'unknown',
      discord_id: m.discord_id ? String(m.discord_id).slice(0, 25) : null,
      body: m.body.trim().slice(0, MAX_BODY),
    }));
}

function intParam(v, def, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : def;
}

// Compute the stat-weighted bounty reward. Dangerous targets cost more.
function bountyReward(s) {
  const kills = Number(s.kills) || 0;
  const deaths = Number(s.deaths) || 0;
  const streak = Number(s.kill_streak) || 0;
  const best = Number(s.longest_streak) || 0;
  const hours = (Number(s.playtime_seconds) || 0) / 3600;
  const kd = kills / Math.max(1, deaths);
  let reward = 100
    + kills * 10
    + Math.max(0, kills - deaths) * 5
    + streak * 15
    + best * 5
    + hours * 3
    + kd * 20;
  reward = Math.min(2000, Math.round(reward / 10) * 10);
  return Math.max(100, reward);
}

export async function calcBountyFor(app, targetName) {
  const { rows } = await app.pg.query(
    `SELECT p.id, p.username, s.kills, s.deaths, s.kill_streak, s.longest_streak, s.playtime_seconds
     FROM players p LEFT JOIN player_stats s ON s.player_id = p.id
     WHERE lower(p.username) = lower($1) LIMIT 1`, [targetName]);
  if (!rows.length) return null;
  return { id: rows[0].id, username: rows[0].username, reward: bountyReward(rows[0]) };
}

export default async function chatRoutes(app) {
  const pluginSecret = process.env.PLUGIN_SHARED_SECRET;
  const botSecret = process.env.BOT_SECRET;

  const requirePlugin = async (req, reply) => {
    if (!pluginSecret || !safeEq(req.headers['x-plugin-secret'], pluginSecret))
      return reply.code(401).send({ error: 'unauthorized' });
  };
  const requireBot = async (req, reply) => {
    if (!botSecret || !safeEq(req.headers['x-bot-secret'], botSecret))
      return reply.code(401).send({ error: 'unauthorized' });
  };

  // ---------------- chat bridge ----------------

  // Plugin pushes in-game chat lines to be shown in #server-chat.
  app.post('/v1/plugin/chat/ingest', { preHandler: requirePlugin }, async (req) => {
    const msgs = cleanMessages(req.body?.messages);
    if (!msgs.length) return { accepted: 0 };
    const values = [];
    const params = [];
    msgs.forEach((m, i) => {
      const b = i * 4;
      values.push(`('mc', $${b + 1}, NULL, $${b + 2}, $${b + 3}, now())`);
      params.push(m.name, m.name, m.body);
    });
    await app.pg.query(
      `INSERT INTO chat_messages (direction, mc_name, discord_id, author, body, created_at)
       VALUES ${values.join(',')}`, params);
    return { accepted: msgs.length };
  });

  // Plugin polls Discord lines (+ system broadcasts) to show in-game.
  app.get('/v1/plugin/chat/out', { preHandler: requirePlugin }, async (req) => {
    const since = intParam(req.query?.since, 0, 0, 2 ** 48);
    const { rows } = await app.pg.query(
      `SELECT id::text, direction, COALESCE(mc_name, '') AS mc_name, discord_id,
              COALESCE(author, '') AS author, body
       FROM chat_messages
       WHERE id > $1 AND direction IN ('discord', 'broadcast')
       ORDER BY id ASC LIMIT 25`, [since]);
    return { messages: rows };
  });

  // Bot pushes Discord #server-chat lines to be broadcast in-game.
  app.post('/v1/bot/chat/in', { preHandler: requireBot }, async (req) => {
    const msgs = cleanMessages(req.body?.messages);
    if (!msgs.length) return { accepted: 0 };
    const values = [];
    const params = [];
    msgs.forEach((m, i) => {
      const b = i * 3;
      values.push(`('discord', NULL, $${b + 1}, $${b + 2}, $${b + 3}, now())`);
      params.push(m.discord_id, m.name, m.body);
    });
    await app.pg.query(
      `INSERT INTO chat_messages (direction, mc_name, discord_id, author, body, created_at)
       VALUES ${values.join(',')}`, params);
    return { accepted: msgs.length };
  });

  // Bot polls in-game chat lines to post into #server-chat.
  app.get('/v1/bot/chat/out', { preHandler: requireBot }, async (req) => {
    const since = intParam(req.query?.since, 0, 0, 2 ** 48);
    const { rows } = await app.pg.query(
      `SELECT id::text, COALESCE(mc_name, '') AS mc_name, body
       FROM chat_messages WHERE id > $1 AND direction = 'mc'
       ORDER BY id ASC LIMIT 25`, [since]);
    return { messages: rows };
  });

  // ---------------- offline-auth name registry ----------------

  // Plugin asks on join: allow / limbo / kick.
  app.post('/v1/plugin/registry/check', { preHandler: requirePlugin }, async (req) => {
    const b = req.body ?? {};
    const name = String(b.username ?? '').trim().slice(0, 32);
    const uuid = String(b.uuid ?? '').trim().slice(0, 40);
    const edition = b.edition === 'bedrock' ? 'bedrock' : 'java';
    if (!name) return { ok: false, action: 'kick', reason: 'invalid username' };

    const reg = await app.pg.query(
      `SELECT auth_type, discord_id FROM name_registry WHERE lower(mc_name) = lower($1)`, [name]);

    if (reg.rows.length) {
      const r = reg.rows[0];
      // Mojang-owned names pass straight through (premium players skip the gate).
      if (r.auth_type === 'mojang' && edition === 'java')
        return { ok: true, action: 'allow', reason: '' };
      // Discord-owned names pass only once that Discord account linked this player.
      const linked = await app.pg.query(
        `SELECT 1 FROM discord_links dl JOIN players p ON p.id = dl.player_id
         WHERE p.uuid = $1 AND dl.discord_id = $2`,
        [uuid, r.discord_id]);
      if (linked.rows.length) return { ok: true, action: 'allow', reason: '' };
      return { ok: true, action: 'limbo', reason:
        'This username is tied to a Discord account. Run /link in-game and claim the code with /link <code> in Discord.' };
    }

    // Bedrock players always link through Discord (their names can't be Mojang-verified).
    if (edition === 'bedrock')
      return { ok: true, action: 'limbo', reason:
        'Bedrock players verify through Discord. Run /link in-game, then /link <code> in our Discord server.' };

    // Unknown Java name: if it exists as a premium Mojang account, register it
    // as mojang-owned and allow. First-claim-wins.
    try {
      const r2 = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
        { signal: AbortSignal.timeout(4000) });
      if (r2.ok) {
        await app.pg.query(
          `INSERT INTO name_registry (mc_name, auth_type) VALUES ($1, 'mojang')
           ON CONFLICT (mc_name) DO NOTHING`, [name]);
        return { ok: true, action: 'allow', reason: '' };
      }
    } catch { /* offline API — fall through to limbo */ }

    // Not a premium name: offline-mode player, they link through Discord.
    await app.pg.query(`UPDATE players SET in_limbo = true WHERE lower(username) = lower($1)`, [name]).catch(() => {});
    return { ok: true, action: 'limbo', reason:
      'You are not verified yet. Run /link in-game, then /link <code> in our Discord server to unlock chat and building.' };
  });

  // Plugin polls while a limbo player waits for their Discord link.
  app.get('/v1/plugin/registry/status', { preHandler: requirePlugin }, async (req) => {
    const name = String(req.query?.username ?? '').trim().slice(0, 32);
    if (!name) return { registered: false, linked: false };
    const reg = await app.pg.query(
      `SELECT r.auth_type, r.discord_id FROM name_registry r WHERE lower(r.mc_name) = lower($1)`, [name]);
    if (!reg.rows.length) return { registered: false, linked: false };
    const r = reg.rows[0];
    const linked = await app.pg.query(
      `SELECT 1 FROM discord_links dl JOIN players p ON p.id = dl.player_id
       WHERE lower(p.username) = lower($1) AND dl.discord_id = $2`, [name, r.discord_id]);
    const ok = r.auth_type === 'mojang' || linked.rows.length > 0;
    if (ok) await app.pg.query(`UPDATE players SET in_limbo = false WHERE lower(username) = lower($1)`, [name]).catch(() => {});
    return { registered: true, linked: ok };
  });

  // ---------------- in-game bounty ----------------

  // Plugin: player runs /bounty <target> in-game.
  app.post('/v1/plugin/bounty', { preHandler: requirePlugin }, async (req) => {
    const b = req.body ?? {};
    const poster = String(b.username ?? '').trim().slice(0, 32);
    const target = String(b.target ?? '').trim().slice(0, 16);
    if (!poster || !target) return { ok: false, msg: 'usage: /bounty <player>' };
    if (poster.toLowerCase() === target.toLowerCase()) return { ok: false, msg: 'you cannot bounty yourself' };
    const link = await app.pg.query(
      `SELECT dl.discord_id, p.username FROM discord_links dl JOIN players p ON p.id = dl.player_id
       WHERE lower(p.username) = lower($1)`, [poster]);
    if (!link.rows.length) return { ok: false, msg: 'link your account first: /link in-game' };
    const exists = await app.pg.query(
      `SELECT 1 FROM bounties WHERE lower(target_username) = lower($1) AND status = 'open'`, [target]);
    if (exists.rows.length) return { ok: false, msg: `a bounty is already open on ${target}` };
    const calc = await calcBountyFor(app, target);
    if (!calc) return { ok: false, msg: 'target not found on the server' };
    await app.pg.query(
      `INSERT INTO bounties (target_username, poster_discord_id, poster_name, reward)
       VALUES ($1, $2, $3, $4)`, [calc.username, link.rows[0].discord_id, poster, calc.reward]);
    return { ok: true, target: calc.username, reward: calc.reward,
             msg: `Bounty posted on ${calc.username} — ${calc.reward} honor to whoever kills them.` };
  });

  // ---------------- birthdays ----------------

  // Bot: player sets their birthday (day + month only).
  app.post('/v1/bot/birthday', { preHandler: requireBot }, async (req, reply) => {
    const b = req.body ?? {};
    const did = String(b.discord_id ?? '');
    if (!/^\d{2,25}$/.test(did)) return reply.code(400).send({ error: 'discord_id required' });
    const month = Math.trunc(Number(b.month));
    const day = Math.trunc(Number(b.day));
    if (!Number.isInteger(month) || month < 1 || month > 12)
      return reply.code(400).send({ error: 'month must be 1-12' });
    if (!Number.isInteger(day) || day < 1 || day > 31)
      return reply.code(400).send({ error: 'day must be 1-31' });
    const daysIn = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (day > daysIn[month - 1]) return reply.code(400).send({ error: 'that day does not exist in that month' });
    const mmdd = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const link = await app.pg.query(
      `SELECT p.id FROM discord_links dl JOIN players p ON p.id = dl.player_id WHERE dl.discord_id = $1`, [did]);
    if (!link.rows.length) return reply.code(403).send({ error: 'link your account first: /link in-game, then /link <code> here' });
    await app.pg.query(`UPDATE players SET birthday = $1 WHERE id = $2`, [mmdd, link.rows[0].id]);
    return { ok: true, birthday: mmdd };
  });

  // Bot polls once an hour: today's birthdays not yet announced.
  app.get('/v1/bot/birthdays', { preHandler: requireBot }, async () => {
    const { rows } = await app.pg.query(
      `SELECT p.id::text, p.username, p.birthday FROM players p
       JOIN discord_links dl ON dl.player_id = p.id
       WHERE p.birthday = to_char(now(), 'MM-DD')
         AND NOT EXISTS (
           SELECT 1 FROM birthday_posts bp
           WHERE bp.player_id = p.id AND bp.posted_on = now()::date)
       LIMIT 10`);
    return { rows };
  });

  // Bot marks them announced (also queues an in-game broadcast).
  app.post('/v1/bot/birthday_posted', { preHandler: requireBot }, async (req) => {
    const b = req.body ?? {};
    const pid = Number(b.player_id);
    const name = String(b.username ?? '').slice(0, 32);
    if (!Number.isInteger(pid)) return { ok: false };
    await app.pg.query(
      `INSERT INTO birthday_posts (player_id, posted_on) VALUES ($1, now()::date)
       ON CONFLICT DO NOTHING`, [pid]);
    if (name) {
      await app.pg.query(
        `INSERT INTO chat_messages (direction, mc_name, discord_id, author, body)
         VALUES ('broadcast', NULL, NULL, 'birthday', $1)`,
        [`\u00a76\u00a7lHappy birthday, ${name}! \u00a7eThe Shattered SMP community wishes you a good one.`]);
    }
    return { ok: true };
  });
}
