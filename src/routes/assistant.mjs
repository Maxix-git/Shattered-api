// POST /v1/assistant/chat — website AI assistant ("Shard").
// Two modes:
//   - LLM mode (ASSISTANT_LLM_KEY set): live answers via Groq's OpenAI-
//     compatible API, grounded with real server data (status, leaderboard,
//     bounties, factions). Model: ASSISTANT_LLM_MODEL (default
//     openai/gpt-oss-20b; retired Groq model ids are remapped automatically).
//     If Groq fails or times out, falls back to stub and flags degraded.
//   - Stub mode (no key): pattern-matched canned answers that still answer
//     from live data.
import crypto from 'node:crypto';

function safeEq(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const PERSONALITY = process.env.ASSISTANT_PERSONALITY ||
  'A witty, slightly chaotic Minecraft greeter who loves anarchy servers.';

// ---- Groq model handling --------------------------------------------------
// Groq retires models on a schedule. llama-3.1-8b-instant and
// llama-3.3-70b-versatile were shut down on 2026-08-16 (free/dev tier), and
// qwen/qwen3.6-27b on 2026-09-14. A Render env var still pointing at one of
// them makes every Groq call fail, so we remap them automatically.
const DEFAULT_MODEL = 'openai/gpt-oss-20b';
const FALLBACK_MODEL = 'openai/gpt-oss-120b';
const RETIRED_MODELS = {
  'llama-3.1-8b-instant': 'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile': 'openai/gpt-oss-120b',
  'llama3-8b-8192': 'openai/gpt-oss-20b',
  'llama3-70b-8192': 'openai/gpt-oss-120b',
  'gemma2-9b-it': 'openai/gpt-oss-20b',
  'qwen/qwen3-32b': 'openai/gpt-oss-120b',
  'qwen/qwen3.6-27b': 'openai/gpt-oss-120b',
  'meta-llama/llama-4-scout-17b-16e-instruct': 'openai/gpt-oss-120b',
  'meta-llama/llama-4-maverick-17b-128e-instruct': 'openai/gpt-oss-120b',
  'moonshotai/kimi-k2-instruct': 'openai/gpt-oss-120b',
  'moonshotai/kimi-k2-instruct-0905': 'openai/gpt-oss-120b',
};

// Read env at CALL time (never at import time) so .env/dashboard changes and
// import order can never leave these stale.
const cfgName = () => (process.env.ASSISTANT_NAME || 'Shard').trim() || 'Shard';
function cfgKey() {
  // Tolerate pasted quotes / spaces / newlines and the GROQ_API_KEY alias.
  const raw = process.env.ASSISTANT_LLM_KEY || process.env.GROQ_API_KEY || '';
  return raw.trim().replace(/^['"]+|['"]+$/g, '').trim();
}
const cfgBase = () =>
  (process.env.ASSISTANT_LLM_URL || 'https://api.groq.com/openai/v1').trim().replace(/\/+$/, '');
function cfgModel() {
  const wanted = (process.env.ASSISTANT_LLM_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const mapped = RETIRED_MODELS[wanted];
  return { wanted, model: mapped || wanted, remapped: !!mapped };
}
const isGptOss = (m) => /^openai\/gpt-oss/i.test(m);

// Last Groq outcome, kept in memory so /config and /diagnose can tell the
// truth instead of just "a key is set".
const health = { ok: null, at: 0, status: 0, message: '', model: '' };
function recordOk(model) {
  Object.assign(health, { ok: true, at: Date.now(), status: 200, message: '', model });
}
function recordFail(model, status, message) {
  Object.assign(health, { ok: false, at: Date.now(), status, message: String(message).slice(0, 300), model });
}

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

// Turn a Groq failure into a plain-English cause + fix (never includes secrets).
function explain(status, apiMessage, model) {
  const m = apiMessage ? ` Groq said: "${String(apiMessage).slice(0, 160)}"` : '';
  if (status === 401) return `Groq rejected the API key (401). Create a new key at console.groq.com/keys and set ASSISTANT_LLM_KEY on the API host (no quotes, no spaces).${m}`;
  if (status === 403) return `Groq refused the request (403) - the key may be disabled, or the host IP is blocked.${m}`;
  if (status === 404) return `Model "${model}" was not found on Groq (404). It was probably retired - set ASSISTANT_LLM_MODEL=${DEFAULT_MODEL} or delete that variable.${m}`;
  if (status === 429) return `Groq rate limit or quota hit (429). Wait a minute, or check your limits at console.groq.com.${m}`;
  if (status === 400) return `Groq rejected the request (400).${m}`;
  if (status >= 500) return `Groq is having an outage (${status}). It usually clears up on its own.${m}`;
  if (status === 0) return `Could not reach api.groq.com from the API host (network error or timeout).${m}`;
  return `Groq returned ${status}.${m}`;
}

// One raw call to the chat-completions endpoint. Throws {status, message}.
async function callGroq(key, model, messages, { maxTokens = 400, timeoutMs = 10_000 } = {}) {
  const post = async (lean) => {
    const body = { model, temperature: 0.8, messages };
    if (isGptOss(model)) {
      body.max_completion_tokens = Math.max(maxTokens, 512);
      if (!lean) { body.reasoning_effort = 'low'; body.include_reasoning = false; }
    } else {
      body.max_tokens = maxTokens;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${cfgBase()}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
          'user-agent': 'shattered-api/1.0 (+assistant)',
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const err = new Error(e?.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e?.message || 'network error'));
      err.status = 0;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await post(false);
  // Some models reject the reasoning knobs; retry once without them.
  if (res.status === 400 && isGptOss(model)) res = await post(true);

  if (!res.ok) {
    let apiMsg = '';
    try { apiMsg = (await res.json())?.error?.message || ''; } catch {}
    const err = new Error(apiMsg || `groq ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  const choice = j.choices?.[0];
  const text = choice?.message?.content?.trim();
  if (!text) {
    const err = new Error(`empty completion (finish_reason: ${choice?.finish_reason ?? 'unknown'})`);
    err.status = 200;
    throw err;
  }
  return text;
}

// Try the configured model, then the fallback model. Records health either way.
async function groqChat(key, msg, context) {
  const { model } = cfgModel();
  const chain = [...new Set([model, FALLBACK_MODEL])];
  const messages = [
    {
      role: 'system',
      content:
        `You are ${cfgName()}, the AI assistant of Shattered SMP, a semi-anarchy Minecraft server ` +
        `(no rules, no resets). Personality: ${PERSONALITY} Keep replies short (1-4 sentences), ` +
        `casual, a little dark-humored but friendly. Never invent player names or stats - use only ` +
        `the live data below, and say you don't know when it isn't there.\n\nLIVE DATA:\n${context}`,
    },
    { role: 'user', content: msg },
  ];
  let lastErr;
  for (const m of chain) {
    try {
      const text = await callGroq(key, m, messages, { maxTokens: 400 });
      recordOk(m);
      return { text, model: m };
    } catch (e) {
      lastErr = e;
      recordFail(m, e.status ?? 0, explain(e.status ?? 0, e.message, m));
      console.error(`[assistant] groq call failed (model ${m}, status ${e.status ?? 0}): ${e.message}`);
      // Bad key / blocked / rate limited: a second model will not help.
      if ([401, 403, 429].includes(e.status)) break;
    }
  }
  throw lastErr;
}

// Cheap health probe used by /config and /diagnose.
async function probe(key) {
  const { model } = cfgModel();
  const t0 = Date.now();
  try {
    const text = await callGroq(key, model, [{ role: 'user', content: 'Reply with the single word: ok' }],
      { maxTokens: 64, timeoutMs: 8_000 });
    recordOk(model);
    return { ok: true, status: 200, model, ms: Date.now() - t0, sample: text.slice(0, 40) };
  } catch (e) {
    const status = e.status ?? 0;
    // An empty completion still proves the key + model work.
    if (status === 200) { recordOk(model); return { ok: true, status, model, ms: Date.now() - t0, sample: '' }; }
    recordFail(model, status, explain(status, e.message, model));
    return { ok: false, status, model, ms: Date.now() - t0, problem: explain(status, e.message, model) };
  }
}

export default async function assistantRoutes(app) {
  app.post('/v1/assistant/chat', async (req, reply) => {
    const NAME = cfgName();
    const msg = typeof req.body?.message === 'string'
      ? req.body.message.trim().slice(0, 500) : '';
    if (!msg) return reply.code(400).send({ error: 'message required' });

    const llmKey = cfgKey();
    let degraded = false;
    if (llmKey) {
      try {
        const context = await liveContext(app.pg);
        const { text, model } = await groqChat(llmKey, msg, context);
        return { name: NAME, mode: 'llm', model, reply: text };
      } catch (e) {
        degraded = true;
        // already logged + recorded in groqChat; fall through to stub mode
      }
    }

    const m = msg.toLowerCase();
    const out = (text) => ({ name: NAME, mode: 'stub', degraded, reply: text });
    try {
      if (/\b(status|online|server up|tps)\b/.test(m)) {
        const s = await app.pg.query(
          `SELECT online_players, max_players, tps, motd, version, recorded_at,
                  (now() - recorded_at) < interval '90 seconds' AS is_live
           FROM server_status ORDER BY recorded_at DESC LIMIT 1`);
        const row = s.rows[0];
        return out(row?.is_live
          ? `${NAME}: Server is LIVE! ${row.online_players}/${row.max_players} online, TPS ${Number(row.tps).toFixed(1)}. MOTD: "${row.motd}"`
          : `${NAME}: No live heartbeat right now - server is offline or just started. Player records are still viewable though!`);
      }
      if (/\b(top|leaderboard|best|rank)\b/.test(m)) {
        const lb = await app.pg.query(
          `SELECT p.username, ps.kills FROM player_stats ps
           JOIN players p ON p.id = ps.player_id
           ORDER BY ps.kills DESC LIMIT 5`);
        const lines = lb.rows.map((r, i) => `${i + 1}. ${r.username} (${r.kills} kills)`);
        return out(lines.length
          ? `${NAME}: Top killers right now:\n${lines.join('\n')}`
          : `${NAME}: No kills recorded yet. Be the first to make history!`);
      }
      if (/\bbount\w*\b/.test(m)) {
        const b = await app.pg.query(
          `SELECT target_username, poster_name, reward FROM bounties
           WHERE status = 'open' ORDER BY created_at DESC LIMIT 5`);
        return out(b.rows.length
          ? `${NAME}: Open bounties:\n${b.rows.map(r => `• ${r.target_username} - ${r.reward} honor (posted by ${r.poster_name})`).join('\n')}`
          : `${NAME}: The board is clean. No open bounties - post one on the website!`);
      }
      if (/^\/?(help|commands?)$|\bwhat can you\b/.test(m)) {
        return out(degraded
          ? `${NAME}: My AI brain is offline right now, but I can still answer from live data - try "status", "top killers" or "bounties".`
          : `${NAME}: I'm in basic mode. Try asking for "status", "top killers" or "bounties"!`);
      }
      return out(degraded
        ? `${NAME}: My AI brain is offline at the moment, so I can only do the basics - try "status", "top" or "bounties".`
        : `${NAME}: ${PERSONALITY.split('.')[0]}... but my full brain isn't switched on yet (basic mode). Try "status", "top" or "bounties"!`);
    } catch (e) {
      console.error('assistant stub failed:', e.message);
      return reply.code(500).send({ error: 'assistant unavailable' });
    }
  });

  // Public + cheap: mode is the TRUTH (llm only if the last Groq call worked).
  app.get('/v1/assistant/config', async () => {
    const key = cfgKey();
    if (!key) return { name: cfgName(), mode: 'stub', model: null };
    const stale = health.ok === null || Date.now() - health.at > 5 * 60_000;
    if (stale) await probe(key);
    return {
      name: cfgName(),
      mode: health.ok ? 'llm' : 'degraded',
      model: cfgModel().model,
    };
  });

  // Owner-only: full Groq diagnosis. Auth = SITE_API_KEY or INTERNAL_SECRET.
  //   curl -H "Authorization: Bearer <SITE_API_KEY>" https://YOUR-API/v1/assistant/diagnose
  app.get('/v1/assistant/diagnose', async (req, reply) => {
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const ok = token && [process.env.SITE_API_KEY, process.env.INTERNAL_SECRET]
      .filter(Boolean).some(k => safeEq(token, k));
    if (!ok) return reply.code(401).send({ error: 'unauthorized' });

    const key = cfgKey();
    const { wanted, model, remapped } = cfgModel();
    const out = {
      key_present: !!key,
      key_looks_valid: key.startsWith('gsk_'),
      key_length: key.length,
      key_source: process.env.ASSISTANT_LLM_KEY ? 'ASSISTANT_LLM_KEY' : process.env.GROQ_API_KEY ? 'GROQ_API_KEY' : null,
      base_url: cfgBase(),
      model_configured: wanted,
      model_in_use: model,
      model_was_retired_and_remapped: remapped,
      fallback_model: FALLBACK_MODEL,
      last_result: health.ok === null ? null : { ...health, age_s: Math.round((Date.now() - health.at) / 1000) },
    };
    if (!key) {
      out.verdict = 'No Groq key found. Set ASSISTANT_LLM_KEY on the API host and redeploy.';
      return out;
    }
    out.probe = await probe(key);
    // Ask Groq which models this key can actually use.
    try {
      const r = await fetch(`${cfgBase()}/models`, {
        headers: { authorization: `Bearer ${key}`, 'user-agent': 'shattered-api/1.0 (+assistant)' },
        signal: AbortSignal.timeout(8_000),
      });
      if (r.ok) {
        const ids = ((await r.json()).data || []).map(x => x.id).sort();
        out.models_available_to_key = ids;
        out.model_exists_on_groq = ids.includes(model);
      } else {
        out.models_lookup = `HTTP ${r.status}`;
      }
    } catch (e) {
      out.models_lookup = `failed: ${e.message}`;
    }
    out.verdict = out.probe.ok
      ? 'Groq works. The assistant is in AI mode.'
      : out.probe.problem;
    return out;
  });
}
