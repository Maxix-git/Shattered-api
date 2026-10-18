// POST /v1/assistant/chat — website AI assistant.
// Stub mode (no ASSISTANT_LLM_KEY): pattern-matched canned answers that still
// demonstrate the toolset by querying live data. LLM mode: TODO Step 5.5 full.
import crypto from 'node:crypto';

function safeEq(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const NAME = process.env.ASSISTANT_NAME || 'Shatty';
const PERSONALITY = process.env.ASSISTANT_PERSONALITY ||
  'A witty, slightly chaotic Minecraft greeter who loves anarchy servers.';

export default async function assistantRoutes(app) {
  app.post('/v1/assistant/chat', async (req, reply) => {
    const msg = typeof req.body?.message === 'string'
      ? req.body.message.trim().slice(0, 500) : '';
    if (!msg) return reply.code(400).send({ error: 'message required' });

    const llmKey = process.env.ASSISTANT_LLM_KEY;
    if (llmKey) {
      // Full LLM mode arrives in the Step 5.5 build-out; treat presence of key
      // as config error until then so nobody thinks it is live.
      return { name: NAME, mode: 'stub',
        reply: `${NAME}: LLM mode is not wired yet — remove ASSISTANT_LLM_KEY or wait for the full build.` };
    }

    const m = msg.toLowerCase();
    try {
      if (/\bstatus|online|server up|tps\b/.test(m)) {
        const s = await app.pg.query(
          `SELECT online_players, max_players, tps, motd, version, recorded_at,
                  (now() - recorded_at) < interval '90 seconds' AS is_live
           FROM server_status ORDER BY recorded_at DESC LIMIT 1`);
        const row = s.rows[0];
        const reply = row?.is_live
          ? `${NAME}: Server is LIVE! ${row.online_players}/${row.max_players} online, TPS ${Number(row.tps).toFixed(1)}. MOTD: "${row.motd}"`
          : `${NAME}: No live heartbeat right now — server is offline or just started. Player records are still viewable though!`;
        return { name: NAME, mode: 'stub', reply };
      }
      if (/\btop|leaderboard|best|rank\b/.test(m)) {
        const lb = await app.pg.query(
          `SELECT p.username, ps.kills FROM player_stats ps
           JOIN players p ON p.id = ps.player_id
           ORDER BY ps.kills DESC LIMIT 5`);
        const lines = lb.rows.map((r, i) => `${i + 1}. ${r.username} (${r.kills} kills)`);
        const reply = lines.length
          ? `${NAME}: Top killers right now:\n${lines.join('\n')}`
          : `${NAME}: No kills recorded yet. Be the first to make history!`;
        return { name: NAME, mode: 'stub', reply };
      }
      if (/^\/?(help|commands?)$|\bwhat can you\b/.test(m)) {
        return { name: NAME, mode: 'stub',
          reply: `${NAME}: I'm in stub mode until my brain is switched on. Try asking for "status" or "top killers"!` };
      }
      return { name: NAME, mode: 'stub',
        reply: `${NAME}: ${PERSONALITY.split('.')[0]}... but my full brain isn't online yet (stub mode). Try "status" or "top"!` };
    } catch {
      return reply.code(500).send({ error: 'assistant unavailable' });
    }
  });

  app.get('/v1/assistant/config', async () => ({
    name: NAME,
    mode: process.env.ASSISTANT_LLM_KEY ? 'llm' : 'stub',
  }));
}
