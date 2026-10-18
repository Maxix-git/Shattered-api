// POST /v1/assistant/chat — website AI assistant ("Shard").
// Two modes:
//   - LLM mode (ASSISTANT_LLM_KEY set): live answers via Groq's OpenAI-
//     compatible API, grounded with real server data (status, leaderboard,
//     bounties, factions). Model: ASSISTANT_LLM_MODEL (default
//     llama-3.1-8b-instant). If Groq fails or times out, falls back to stub.
//   - Stub mode (no key): pattern-matched canned answers that still answer
//     from live data.
import crypto from 'node:crypto';

function safeEq(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const NAME = process.env.ASSISTANT_NAME || 'Shatty';
const PERSONALITY = process.env.ASSISTANT_PERSONALITY ||
  'A witty, slightly chaotic Minecraft greeter who loves anarchy servers.';
const LLM_MODEL = process.env.ASSISTANT_LLM_MODEL || 'llama-3.1-8b-instant';

// Small grounding block from the DB so Shard answers with real data.
async function liveContext(pg) {
  const parts = [];
  try {
    const s = await pg.query(
      `SELECT online_players, max_players, tps, motd,
              (now() - recorded_at) < interval '90 seconds' AS is_live
       FROM server_status ORDER BY recorded_at DESC LIMIT 1`);
    const row = s.rows[0];
    parts.push(row?.is_live
      ? `Server LIVE: ${row.online_players}/${row.max_players} online, TPS ${Number(row.tps).toFixed(1)}`
      : 'Server offline (no recent heartbeat).');
  } catch {}
  try {
    const lb = await pg.query(
      `SELECT p.username, ps.kills FROM player_stats ps
       JOIN players p ON p.id = ps.player_id ORDER BY ps.kills DESC LIMIT 5`);
    parts.push(lb.rows.length
      ? `Top killers: ${lb.rows.map(r => `${r.username} (${r.kills})`).join(', ')}`
      : 'No kills recorded yet.');
  } catch {}
  try {
    const b = await pg.query(
      `SELECT target_username, poster_name, reward FROM bounties
       WHERE status = 'open' ORDER BY created_at DESC LIMIT 5`);
    parts.push(b.rows.length
      ? `Open bounties: ${b.rows.map(r => `${r.target_username} (${r.reward} honor, posted by ${r.poster_name})`).join('; ')}`
      : 'No open bounties.');
  } catch {}
  try {
    const f = await pg.query(`SELECT count(*) AS c FROM factions`);
    parts.push(`Factions: ${f.rows[0]?.c ?? 0}.`);
  } catch {}
  return parts.join('\n');
}

async function groqChat(key, msg, context) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 400,
        temperature: 0.8,
        messages: [
          {
            role: 'system',
            content:
              `You are ${NAME}, the AI assistant of Shattered SMP, a semi-anarchy Minecraft server ` +
              `(no rules, no resets). Personality: ${PERSONALITY} Keep replies short (1-4 sentences), ` +
              `casual, a little dark-humored but friendly. Never invent player names or stats — use only ` +
              `the live data below, and say you don't know when it isn't there.\n\nLIVE DATA:\n${context}`,
          },
          { role: 'user', content: msg },
        ],
      }),
    });
    if (!res.ok) throw new Error(`groq ${res.status}`);
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty completion');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export default async function assistantRoutes(app) {
  app.post('/v1/assistant/chat', async (req, reply) => {
    const msg = typeof req.body?.message === 'string'
      ? req.body.message.trim().slice(0, 500) : '';
    if (!msg) return reply.code(400).send({ error: 'message required' });

    const llmKey = process.env.ASSISTANT_LLM_KEY;
    if (llmKey) {
      try {
        const context = await liveContext(app.pg);
        const replyText = await groqChat(llmKey, msg, context);
        return { name: NAME, mode: 'llm', reply: replyText };
      } catch (e) {
        console.error('groq call failed, falling back to stub:', e.message);
        // fall through to stub mode below
      }
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
      if (/\bbount\w*\b/.test(m)) {
        const b = await app.pg.query(
          `SELECT target_username, poster_name, reward FROM bounties
           WHERE status = 'open' ORDER BY created_at DESC LIMIT 5`);
        const reply = b.rows.length
          ? `${NAME}: Open bounties:\n${b.rows.map(r => `• ${r.target_username} — ${r.reward} honor (posted by ${r.poster_name})`).join('\n')}`
          : `${NAME}: The board is clean. No open bounties — post one on the website!`;
        return { name: NAME, mode: 'stub', reply };
      }
      if (/^\/?(help|commands?)$|\bwhat can you\b/.test(m)) {
        return { name: NAME, mode: 'stub',
          reply: llmKey
            ? `${NAME}: Ask me anything about the realm — status, top killers, bounties, or just chat.`
            : `${NAME}: I'm in stub mode until my brain is switched on. Try asking for "status" or "top killers"!` };
      }
      return { name: NAME, mode: 'stub',
        reply: `${NAME}: ${PERSONALITY.split('.')[0]}... but my full brain isn't online yet (stub mode). Try "status" or "top"!` };
    } catch (e) {
      console.error('assistant stub failed:', e.message);
      return reply.code(500).send({ error: 'assistant unavailable' });
    }
  });

  app.get('/v1/assistant/config', async () => ({
    name: NAME,
    mode: process.env.ASSISTANT_LLM_KEY ? 'llm' : 'stub',
    model: process.env.ASSISTANT_LLM_KEY ? LLM_MODEL : null,
  }));
}
