// Site RPC bridge: the TanStack Start website is a stateless client that calls
// this single endpoint (POST /api/site/rpc, Bearer SITE_API_KEY) for all live
// data and write actions. Ops: "live", "me", "act".
//
// Auth lives site-side (Discord OAuth + HMAC sessions + CSRF). This endpoint
// only authenticates the *site* (shared key) and trusts the user identity the
// site forwards in the body for per-user scoping.
import crypto from 'node:crypto';

function safeEq(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Honor is earned, never bought: kills + streaks + playtime + bounty claims.
function honor(kills, longest, playtimeSec, bountyClaims) {
  const hours = Math.floor((playtimeSec || 0) / 3600);
  return (kills || 0) * 2 + (longest || 0) * 5 + hours * 3 + (bountyClaims || 0) * 50;
}

function timeAgo(ts) {
  if (!ts) return 'now';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default async function siteRoutes(app) {
  app.post('/api/site/rpc', async (req, reply) => {
    const key = process.env.SITE_API_KEY;
    if (!key) return reply.code(503).send({ error: 'site api not configured' });
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !safeEq(auth.slice(7), key))
      return reply.code(401).send({ error: 'unauthorized' });

    const body = req.body || {};
    const op = body.op;
    const user = body.user || null; // { u: discord_id, n: name, a: avatar, admin: bool }

    try {
      if (op === 'live') return await live(app);
      if (op === 'me') return await me(app, user);
      if (op === 'act') return await act(app, user, body);
      return reply.code(400).send({ ok: false, msg: 'unknown op' });
    } catch (e) {
      req.log.error({ err: e.message }, 'site rpc failed');
      return reply.code(500).send({ ok: false, msg: 'backend error' });
    }
  });

  // ---- live: everything the public site renders ----
  async function live(app) {
    const pg = app.pg;

    // currently-online usernames (most recent session event is a join)
    const onlineQ = await pg.query(`
      SELECT username FROM (
        SELECT username, type, row_number() OVER (PARTITION BY username ORDER BY id DESC) AS rn
        FROM session_events
      ) t WHERE rn = 1 AND type = 'player_join'`);
    const onlineSet = new Set(onlineQ.rows.map(r => r.username));

    const adminIds = (process.env.ADMIN_DISCORD_IDS || '')
      .split(',').map(x => x.trim()).filter(Boolean);
    const playersQ = await pg.query(`
      SELECT p.username AS name,
             f.name AS faction,
             COALESCE(s.kills, 0) AS kills,
             COALESCE(s.deaths, 0) AS deaths,
             COALESCE(s.kill_streak, 0) AS streak,
             COALESCE(s.longest_streak, 0) AS longest_streak,
             COALESCE(s.playtime_seconds, 0)::bigint AS playtime,
             (SELECT count(*) FROM bounties b WHERE b.target_username = p.username AND b.status = 'open') AS open_bounties,
             (SELECT count(*) FROM bounties b WHERE b.claimed_by = dl.discord_id) AS bounty_claims,
             ($1::text[] IS NOT NULL AND dl.discord_id = ANY($1::text[])) AS is_owner,
             (EXISTS (SELECT 1 FROM donations d3 WHERE d3.discord_id = dl.discord_id
                      AND d3.created_at > now() - interval '30 days')
              OR EXISTS (SELECT 1 FROM donations d4 WHERE d4.mc_name = p.username
                      AND d4.mc_name IS NOT NULL AND d4.created_at > now() - interval '30 days')) AS is_donor,
             (dl.discord_id IS NOT NULL) AS is_linked,
             p.avatar_url
      FROM players p
      LEFT JOIN player_stats s ON s.player_id = p.id
      LEFT JOIN discord_links dl ON dl.player_id = p.id
      LEFT JOIN faction_members fm ON fm.discord_id = dl.discord_id
      LEFT JOIN factions f ON f.id = fm.faction_id
      ORDER BY kills DESC NULLS LAST LIMIT 100`, [adminIds]);
    const players = playersQ.rows.map(r => ({
      name: r.name,
      faction: r.faction || 'Unaffiliated',
      kills: r.kills,
      deaths: r.deaths,
      streak: r.streak,
      hours: Math.floor(r.playtime / 3600),
      online: onlineSet.has(r.name),
      wealth: 0,
      honor: honor(r.kills, r.longest_streak, r.playtime, r.bounty_claims),
      bountyClaims: r.bounty_claims,
      openBounties: r.open_bounties,
      owner: r.is_owner === true,
      donor: r.is_donor === true,
      linked: r.is_linked === true,
      avatar: r.avatar_url || null,
    }));

    const factionsQ = await pg.query(`
      SELECT f.name, f.tag, count(fm.discord_id) AS members,
             COALESCE((SELECT sum(s.kills) FROM faction_members fm2
                       JOIN discord_links dl ON dl.discord_id = fm2.discord_id
                       JOIN player_stats s ON s.player_id = dl.player_id
                       WHERE fm2.faction_id = f.id), 0)::int AS kills,
             f.description
      FROM factions f LEFT JOIN faction_members fm ON fm.faction_id = f.id
      GROUP BY f.id ORDER BY kills DESC`);
    const factions = factionsQ.rows.map(r => ({
      name: r.name, tag: r.tag, members: Number(r.members), kills: r.kills,
      description: r.description, alliance: 'None', rival: 'None',
    }));

    const postsQ = await pg.query(`
      SELECT p.id::text, p.title, p.category, p.author, p.body, p.created_at,
             (SELECT count(*) FROM community_posts r WHERE r.parent_id = p.id) AS replies
      FROM community_posts p WHERE p.parent_id IS NULL
      ORDER BY p.created_at DESC LIMIT 30`);
    const posts = postsQ.rows.map(r => ({
      id: r.id, title: r.title || r.body.slice(0, 60), category: r.category,
      author: r.author, time: timeAgo(r.created_at), replies: Number(r.replies), body: r.body,
    }));

    const feedQ = await pg.query(`
      SELECT kv.username AS killer, vv.username AS victim, k.cause, k.occurred_at
      FROM kill_events k
      LEFT JOIN players kv ON kv.id = k.killer_id
      JOIN players vv ON vv.id = k.victim_id
      ORDER BY k.occurred_at DESC LIMIT 30`);
    const feed = feedQ.rows.map(r => [
      r.killer || '—', r.victim, r.cause || 'UNKNOWN', timeAgo(r.occurred_at),
    ]);

    const bountiesQ = await pg.query(`
      SELECT id::text, target_username, poster_name, reward, created_at
      FROM bounties WHERE status = 'open' ORDER BY created_at DESC LIMIT 20`);
    const bounties = bountiesQ.rows.map(r => ({
      id: r.id, target: r.target_username, poster: r.poster_name,
      reward: r.reward, time: timeAgo(r.created_at),
    }));

    const zonesQ = await pg.query(`
      SELECT dimension AS label, count(*) AS count
      FROM kill_events WHERE occurred_at > now() - interval '7 days'
      GROUP BY dimension ORDER BY count DESC LIMIT 5`);
    const zones = zonesQ.rows.map(r => ({ label: r.label, count: Number(r.count) }));

    const metaQ = await pg.query(`
      SELECT (SELECT count(*) FROM players) AS players,
             (SELECT COALESCE(sum(kills), 0) FROM player_stats) AS kills,
             (SELECT count(*) FROM factions) AS factions,
             (SELECT EXTRACT(epoch FROM now() - min(first_join)) / 86400 FROM players) AS age`);
    const m = metaQ.rows[0] || {};

    // Plugin heartbeat = the authoritative "is the server up" signal.
    // (The plugin beats every 30s; >90s old means it stopped.)
    let heartbeat = null;
    try {
      const hb = await pg.query(`
        SELECT online_players, max_players, tps, motd, version,
               EXTRACT(EPOCH FROM (now() - recorded_at))::int AS age
        FROM server_status ORDER BY recorded_at DESC LIMIT 1`);
      const h = hb.rows[0];
      if (h) {
        heartbeat = {
          live: h.age <= 90,
          ageSeconds: h.age,
          playersOnline: h.online_players,
          playersMax: h.max_players,
          tps: Math.round(Number(h.tps) * 10) / 10,
          motd: h.motd || '',
          version: h.version || '',
        };
      }
    } catch (e) {
      app.log.error({ err: e.message }, 'heartbeat lookup failed');
    }

    return {
      players, factions, posts, news: [], feed, bounties, zones,
      meta: {
        players: Number(m.players || 0), kills: Number(m.kills || 0),
        factions: Number(m.factions || 0), worldAgeDays: Math.floor(m.age || 0),
      },
      heartbeat,
    };
  }

  // ---- me: the logged-in user's dashboard payload ----
  async function me(app, user) {
    const pg = app.pg;
    if (!user?.u) {
      return { linked: false, mcName: null, donorUntil: 0, faction: null,
        factionMembers: [], notifications: [], stats: null };
    }
    const did = user.u;

    const linkQ = await pg.query(`
      SELECT p.username, p.id, p.profile_public, p.inventory_public, p.first_join,
             s.kills, s.deaths, s.kill_streak, s.longest_streak, s.playtime_seconds
      FROM discord_links dl JOIN players p ON p.id = dl.player_id
      LEFT JOIN player_stats s ON s.player_id = p.id
      WHERE dl.discord_id = $1`, [did]);
    const link = linkQ.rows[0] || null;

    const donorQ = await pg.query(`
      SELECT COALESCE(extract(epoch from max(created_at) + interval '30 days'), 0)::bigint AS until
      FROM donations WHERE discord_id = $1`, [did]);
    const donorUntil = Number(donorQ.rows[0]?.until || 0);

    const factionQ = await pg.query(`
      SELECT f.id, f.name, f.tag, f.description, fm.role, (f.owner_discord_id = $1) AS is_owner
      FROM faction_members fm JOIN factions f ON f.id = fm.faction_id
      WHERE fm.discord_id = $1`, [did]);
    const faction = factionQ.rows[0] || null;

    let factionMembers = [];
    if (faction) {
      const membersQ = await pg.query(`
        SELECT fm.discord_id, fm.mc_name, fm.role
        FROM faction_members fm WHERE fm.faction_id = $1 ORDER BY fm.joined_at`, [faction.id]);
      factionMembers = membersQ.rows.map(r => ({
        discordId: r.discord_id, mcName: r.mc_name || '—', role: r.role,
      }));
    }

    const notifsQ = await pg.query(`
      SELECT id::text, kind, body, created_at FROM notifications
      WHERE discord_id = $1 AND read_at IS NULL ORDER BY created_at DESC LIMIT 20`, [did]);
    const notifications = notifsQ.rows.map(r => ({
      id: r.id, kind: r.kind, body: r.body, time: timeAgo(r.created_at),
    }));

    let stats = null;
    if (link) {
      const claimsQ = await pg.query(`SELECT count(*) AS c FROM bounties WHERE claimed_by = $1`, [did]);
      stats = {
        kills: link.kills || 0, deaths: link.deaths || 0,
        streak: link.kill_streak || 0, bestStreak: link.longest_streak || 0,
        hours: Math.floor((link.playtime_seconds || 0) / 3600),
        chunks: 0, reputation: 0,
        firstJoin: link.first_join ? Math.floor(new Date(link.first_join).getTime() / 1000) : 0,
        honor: honor(link.kills, link.longest_streak, link.playtime_seconds, claimsQ.rows[0]?.c || 0),
      };
    }

    return {
      linked: !!link, mcName: link?.username || null, donorUntil,
      faction: faction ? {
        id: faction.id, name: faction.name, tag: faction.tag,
        description: faction.description, role: faction.role, isOwner: faction.is_owner,
      } : null,
      factionMembers, notifications, stats,
    };
  }

  // ---- act: write actions (session + CSRF already checked site-side) ----
  async function act(app, user, body) {
    const pg = app.pg;
    if (!user?.u) return { ok: false, msg: 'Log in first.' };
    const did = user.u;
    const name = user.n || did;
    const a = body.args || {};
    const sub = a.op;
    const int0 = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(1, Math.min(500, Math.trunc(n))) : d; };

    if (sub === 'link_claim') {
      const code = String(a.code || '').toUpperCase().slice(0, 6);
      if (!/^[A-Z0-9]{6}$/.test(code)) return { ok: false, msg: 'Enter your 6-character code.' };
      const codeQ = await pg.query(
        `SELECT player_id FROM link_codes WHERE code = $1 AND expires_at > now() AND claimed_at IS NULL`, [code]);
      if (!codeQ.rows.length) return { ok: false, msg: 'Code not found or expired.' };
      const pid = codeQ.rows[0].player_id;
      await pg.query(`INSERT INTO discord_links (player_id, discord_id, discord_username)
        VALUES ($1, $2, $3) ON CONFLICT (player_id) DO UPDATE SET discord_id = $2, discord_username = $3`,
        [pid, did, name]);
      await pg.query(`UPDATE link_codes SET claimed_at = now() WHERE code = $1`, [code]);
      const pn = await pg.query(`SELECT username FROM players WHERE id = $1`, [pid]);
      if (pn.rows[0]?.username) {
        await pg.query(
          `INSERT INTO name_registry (mc_name, auth_type, discord_id) VALUES ($1, 'discord', $2)
           ON CONFLICT (mc_name) DO NOTHING`, [pn.rows[0].username, did]);
        await pg.query(`UPDATE players SET in_limbo = false WHERE id = $1`, [pid]);
      }
      return { ok: true, msg: `Linked to ${pn.rows[0]?.username}.`, linked: true, mcName: pn.rows[0]?.username };
    }

    if (sub === 'bounty') {
      const target = String(a.target || '').trim().slice(0, 16);
      if (!target) return { ok: false, msg: 'Pick a target.' };
      const selfName = await pg.query(
        `SELECT p.username FROM discord_links dl JOIN players p ON p.id = dl.player_id WHERE dl.discord_id = $1`, [did]);
      if (selfName.rows[0] && selfName.rows[0].username.toLowerCase() === target.toLowerCase())
        return { ok: false, msg: 'You cannot bounty yourself.' };
      // Stat-weighted reward, same formula as the bot's /bounty.
      const st = await pg.query(
        `SELECT p.username, s.kills, s.deaths, s.kill_streak, s.longest_streak, s.playtime_seconds
         FROM players p LEFT JOIN player_stats s ON s.player_id = p.id
         WHERE lower(p.username) = lower($1) LIMIT 1`, [target]);
      const r0 = st.rows[0] || { username: target, kills: 0, deaths: 0, kill_streak: 0, longest_streak: 0, playtime_seconds: 0 };
      const hours = (Number(r0.playtime_seconds) || 0) / 3600;
      const kd = (Number(r0.kills) || 0) / Math.max(1, Number(r0.deaths) || 0);
      let reward = 100 + (Number(r0.kills) || 0) * 10
        + Math.max(0, (Number(r0.kills) || 0) - (Number(r0.deaths) || 0)) * 5
        + (Number(r0.kill_streak) || 0) * 15 + (Number(r0.longest_streak) || 0) * 5
        + hours * 3 + kd * 20;
      reward = Math.max(100, Math.min(2000, Math.round(reward / 10) * 10));
      await pg.query(`INSERT INTO bounties (target_username, poster_discord_id, poster_name, reward)
        VALUES ($1, $2, $3, $4)`, [r0.username, did, name, reward]);
      return { ok: true, msg: `Bounty posted on ${r0.username}: ${reward} Honor (auto-priced from their stats).` };
    }

    if (sub === 'post') {
      const text = String(a.body || '').trim().slice(0, 1000);
      if (!text) return { ok: false, msg: 'Write something first.' };
      const recent = await pg.query(`SELECT created_at FROM community_posts
        WHERE discord_id = $1 AND created_at > now() - interval '30 seconds'`, [did]);
      if (recent.rows.length) return { ok: false, msg: 'Slow down — 30s between posts.' };
      await pg.query(`INSERT INTO community_posts (discord_id, author, body) VALUES ($1, $2, $3)`, [did, name, text]);
      return { ok: true, msg: 'Posted to the community wall.' };
    }

    if (sub === 'appeal') {
      const punishment = String(a.punishment || 'ban').slice(0, 16);
      const reason = String(a.reason || '').trim().slice(0, 1000);
      if (!reason) return { ok: false, msg: 'Add a reason.' };
      await pg.query(`INSERT INTO appeals (discord_id, punishment, mc_name, reason) VALUES ($1, $2, $3, $4)`,
        [did, punishment, a.mc_name || null, reason]);
      return { ok: true, msg: 'Appeal submitted. Staff will review it.' };
    }

    if (sub === 'record_donation') {
      if (user?.admin !== true) return { ok: false, msg: 'Owners only.' };
      const discordId = String(a.discord_id || '').trim().slice(0, 25);
      const mcName = String(a.mc_name || '').trim().slice(0, 16);
      const amount = Math.max(0, Math.min(100000, Number(a.amount) || 0));
      if (!discordId && !mcName) return { ok: false, msg: 'Enter a Discord ID or an MC name.' };
      if (discordId && !/^\d{2,25}$/.test(discordId)) return { ok: false, msg: 'Discord ID must be numeric.' };
      await pg.query(
        `INSERT INTO donations (discord_id, mc_name, amount, recorded_by) VALUES ($1, $2, $3, $4)`,
        [discordId || null, mcName || null, amount, String(user?.n || 'owner')]);
      return { ok: true, msg: `Donation recorded — donor badge active for 30 days.` };
    }

    if (sub === 'set_avatar') {
      const avatar = String(a.avatar || '');
      if (!avatar.startsWith('data:image/') || avatar.length > 400_000)
        return { ok: false, msg: 'Pick an image under ~300KB.' };
      const pid = await pg.query(`SELECT player_id FROM discord_links WHERE discord_id = $1`, [did]);
      if (!pid.rows.length) return { ok: false, msg: 'Link your Minecraft account first.' };
      await pg.query(`UPDATE players SET avatar_url = $1 WHERE id = $2`, [avatar, pid.rows[0].player_id]);
      return { ok: true, msg: 'Avatar updated.' };
    }

    if (sub === 'birthday') {
      const month = Math.trunc(Number(a.month));
      const day = Math.trunc(Number(a.day));
      if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31)
        return { ok: false, msg: 'That is not a real date.' };
      const daysIn = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (day > daysIn[month - 1]) return { ok: false, msg: 'That month has fewer days.' };
      const mmdd = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const pid = await pg.query(`SELECT player_id FROM discord_links WHERE discord_id = $1`, [did]);
      if (!pid.rows.length) return { ok: false, msg: 'Link your Minecraft account first.' };
      await pg.query(`UPDATE players SET birthday = $1 WHERE id = $2`, [mmdd, pid.rows[0].player_id]);
      return { ok: true, msg: `Birthday set: ${mmdd}. Only day and month are stored.` };
    }

    if (sub?.startsWith?.('panel_')) {
      if (user?.admin !== true) return { ok: false, msg: 'Owners only.' };
      const AGENT = (process.env.PANEL_AGENT_URL || '').replace(/\/$/, '');
      const SECRET = process.env.PANEL_AGENT_SECRET;
      if (!AGENT || !SECRET)
        return { ok: false, msg: 'Server panel not configured (needs PANEL_AGENT_URL + PANEL_AGENT_SECRET on the API).' };
      const map = {
        panel_status:  { method: 'GET',  path: '/status' },
        panel_log:     { method: 'GET',  path: `/log?lines=${int0(a.lines, 60)}` },
        panel_files:   { method: 'GET',  path: `/files?path=${encodeURIComponent(String(a.path || ''))}` },
        panel_read:    { method: 'GET',  path: `/file?path=${encodeURIComponent(String(a.path || ''))}` },
        panel_write:   { method: 'POST', path: '/file' },
        panel_exec:    { method: 'POST', path: '/exec' },
        panel_backup:  { method: 'POST', path: '/backup' },
        panel_backups: { method: 'GET',  path: '/backups' },
        panel_power:   { method: 'POST', path: '/power' },
      };
      const spec = map[sub];
      if (!spec) return { ok: false, msg: 'Unknown panel op.' };
      const body = sub === 'panel_write' ? { path: String(a.path || ''), content: String(a.content ?? '') }
        : sub === 'panel_exec' ? { command: String(a.command || '') }
        : sub === 'panel_power' ? { action: String(a.action || '') } : undefined;
      try {
        const res = await fetch(`${AGENT}${spec.path}`, {
          method: spec.method,
          headers: { 'content-type': 'application/json', 'x-agent-secret': SECRET },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20_000),
        });
        const data = await res.json().catch(() => ({ error: `agent http ${res.status}` }));
        return res.ok ? { ok: true, ...data } : { ok: false, msg: data.error || `agent error ${res.status}` };
      } catch (e) {
        return { ok: false, msg: `Panel agent unreachable: ${e.message}` };
      }
    }

    if (sub === 'privacy') {
      const pid = await pg.query(`SELECT player_id FROM discord_links WHERE discord_id = $1`, [did]);
      if (!pid.rows.length) return { ok: false, msg: 'Link your Minecraft account first.' };
      await pg.query(`UPDATE players SET profile_public = $1, inventory_public = $2 WHERE id = $3`,
        [!!a.profile_public, !!a.inventory_public, pid.rows[0].player_id]);
      return { ok: true, msg: 'Privacy settings saved.' };
    }

    if (sub === 'faction_create') {
      const fname = String(a.name || '').trim().slice(0, 32);
      if (!fname) return { ok: false, msg: 'Name your faction.' };
      const exists = await pg.query(`SELECT 1 FROM faction_members WHERE discord_id = $1`, [did]);
      if (exists.rows.length) return { ok: false, msg: 'You are already in a faction.' };
      try {
        const ins = await pg.query(`INSERT INTO factions (name, tag, description, owner_discord_id)
          VALUES ($1, $2, $3, $4) RETURNING id`, [fname, a.tag || '—', a.description || 'No description yet.', did]);
        await pg.query(`INSERT INTO faction_members (faction_id, discord_id, mc_name, role) VALUES ($1, $2, $3, 'owner')`,
          [ins.rows[0].id, did, a.mcName || null]);
        return { ok: true, msg: `Faction ${fname} created.` };
      } catch (e) {
        return { ok: false, msg: 'That faction name is taken.' };
      }
    }

    if (sub === 'faction_edit') {
      const r = await pg.query(`UPDATE factions SET tag = $1, description = $2
        WHERE owner_discord_id = $3`, [String(a.tag || '—').slice(0, 8), String(a.description || '').slice(0, 200), did]);
      return r.rowCount ? { ok: true, msg: 'Faction updated.' } : { ok: false, msg: 'Only the owner can edit.' };
    }

    if (sub === 'faction_announce') {
      const text = String(a.body || '').trim().slice(0, 500);
      if (!text) return { ok: false, msg: 'Write an announcement.' };
      const f = await pg.query(`SELECT id FROM factions WHERE owner_discord_id = $1`, [did]);
      if (!f.rows.length) return { ok: false, msg: 'Only the owner can announce.' };
      const members = await pg.query(`SELECT discord_id FROM faction_members WHERE faction_id = $1`, [f.rows[0].id]);
      const note = `Faction announcement: ${text}`;
      for (const m of members.rows) {
        await pg.query(`INSERT INTO notifications (discord_id, kind, body) VALUES ($1, 'faction', $2)`, [m.discord_id, note]);
      }
      return { ok: true, msg: 'Announcement sent to your faction.' };
    }

    if (sub === 'faction_kick') {
      const target = String(a.discord_id || '');
      const f = await pg.query(`DELETE FROM faction_members fm USING factions f
        WHERE fm.faction_id = f.id AND f.owner_discord_id = $1 AND fm.discord_id = $2 AND fm.role <> 'owner'`,
        [did, target]);
      return f.rowCount ? { ok: true, msg: 'Member removed.' } : { ok: false, msg: 'Could not remove that member.' };
    }

    if (sub === 'faction_disband') {
      const r = await pg.query(`DELETE FROM factions WHERE owner_discord_id = $1`, [did]);
      return r.rowCount ? { ok: true, msg: 'Faction disbanded.' } : { ok: false, msg: 'Only the owner can disband.' };
    }

    if (sub === 'notifs_read') {
      await pg.query(`UPDATE notifications SET read_at = now() WHERE discord_id = $1 AND read_at IS NULL`, [did]);
      return { ok: true, msg: 'All caught up.' };
    }

if (sub === 'site_announce') {
      if (user?.admin !== true) return { ok: false, msg: 'Owners only.' };
      const text = String(a.body || '').trim().slice(0, 500);
      if (!text) return { ok: false, msg: 'Write an announcement first.' };
      await pg.query(
        `INSERT INTO announcements (author, body, source) VALUES ($1, $2, 'web')`,
        [String(user?.n || 'owner'), text]);
      return { ok: true, msg: 'Announcement queued — the bot posts it to #announcements within seconds.' };
    }

    if (sub === 'owner_dash') {
      if (user?.admin !== true) return { ok: false, msg: 'Owners only.' };
      const stats = await pg.query(`
        SELECT (SELECT count(*) FROM players) AS players,
               (SELECT count(*) FROM discord_links) AS linked,
               (SELECT count(*) FROM bounties WHERE status = 'open') AS open_bounties,
               (SELECT count(*) FROM appeals WHERE status = 'open') AS open_appeals,
               (SELECT COALESCE(sum(amount), 0) FROM donations
                 WHERE created_at > now() - interval '30 days') AS donations_30d`);
      const dons = await pg.query(`
        SELECT id, COALESCE(mc_name, discord_id) AS who, amount, created_at
        FROM donations ORDER BY created_at DESC LIMIT 10`);
      const apps = await pg.query(`
        SELECT id, COALESCE(mc_name, 'unknown') AS mc_name, discord_id, punishment,
               reason, status, COALESCE(resolution, '') AS resolution, created_at
        FROM appeals ORDER BY created_at DESC LIMIT 15`);
      const bts = await pg.query(`
        SELECT b.id::text, b.target_username, b.poster_name, b.reward, b.created_at
        FROM bounties b WHERE b.status = 'open' ORDER BY b.created_at DESC LIMIT 20`);
      const anns = await pg.query(`
        SELECT id, author, body, created_at, posted_at IS NOT NULL AS posted
        FROM announcements ORDER BY created_at DESC LIMIT 6`);
      const ago = (t) => {
        const s = Math.floor((Date.now() - new Date(t).getTime()) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
        return `${Math.floor(s / 86400)}d ago`;
      };
      return {
        ok: true, msg: '',
        data: {
          stats: {
            players: Number(stats.rows[0].players), linked: Number(stats.rows[0].linked),
            openBounties: Number(stats.rows[0].open_bounties), openAppeals: Number(stats.rows[0].open_appeals),
            donations30d: Number(stats.rows[0].donations_30d),
          },
          donations: dons.rows.map(r => ({ id: r.id, who: r.who, amount: Number(r.amount), time: ago(r.created_at) })),
          appeals: apps.rows.map(r => ({
            id: r.id, mcName: r.mc_name, discordId: r.discord_id, punishment: r.punishment,
            reason: r.reason, status: r.status, resolution: r.resolution, time: ago(r.created_at),
          })),
          bounties: bts.rows.map(r => ({
            id: r.id, target: r.target_username, poster: r.poster_name,
            reward: r.reward, time: ago(r.created_at),
          })),
          announcements: anns.rows.map(r => ({
            id: r.id, author: r.author, body: r.body, posted: r.posted, time: ago(r.created_at),
          })),
        },
      };
    }

    if (sub === 'resolve_appeal') {
      if (user?.admin !== true) return { ok: false, msg: 'Owners only.' };
      const id = Math.trunc(Number(a.id));
      const resolution = a.resolution === 'accepted' ? 'accepted' : 'denied';
      if (!Number.isInteger(id)) return { ok: false, msg: 'Pick an appeal.' };
      const r = await pg.query(
        `UPDATE appeals SET status = 'resolved', resolution = $1, resolved_by = $2, resolved_at = now()
         WHERE id = $3 AND status = 'open' RETURNING discord_id, mc_name, punishment`,
        [resolution, String(user?.n || 'owner'), id]);
      if (!r.rows.length) return { ok: false, msg: 'Appeal not found or already resolved.' };
      const ap = r.rows[0];
      await pg.query(
        `INSERT INTO notifications (discord_id, kind, body) VALUES ($1, 'appeal', $2)`,
        [ap.discord_id,
         `Your ${ap.punishment} appeal was ${resolution}.`]);
      return { ok: true, msg: `Appeal ${resolution}. The player has been notified.` };
    }

    if (sub === 'my_bounties') {
      const r = await pg.query(
        `SELECT b.id::text, b.target_username, b.reward, b.created_at
         FROM bounties b WHERE b.poster_discord_id = $1 AND b.status = 'open'
         ORDER BY b.created_at DESC LIMIT 25`, [did]);
      const ago = (t) => {
        const s = Math.floor((Date.now() - new Date(t).getTime()) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
        return `${Math.floor(s / 86400)}d ago`;
      };
      return { ok: true, msg: '', data: { bounties:
        r.rows.map(x => ({ id: x.id, target: x.target_username, reward: x.reward, time: ago(x.created_at) })) } };
    }

    if (sub === 'bounty_cancel') {
      const id = Math.trunc(Number(a.id));
      if (!Number.isInteger(id)) return { ok: false, msg: 'Pick a bounty.' };
      const r = await pg.query(
        `UPDATE bounties SET status = 'cancelled', claimed_at = now()
         WHERE id = $1 AND poster_discord_id = $2 AND status = 'open'`, [id, did]);
      return r.rowCount
        ? { ok: true, msg: 'Bounty cancelled — it is off the board.' }
        : { ok: false, msg: 'Only your own open bounties can be cancelled.' };
    }

    return { ok: false, msg: 'Unknown action.' };
  }
}
