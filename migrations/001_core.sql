-- 001: Core players, stats, and kill events
-- Shattered SMP Platform — Step 1 foundation schema

-- Players: one row per unique Minecraft identity (Java or Bedrock).
-- Bedrock players (Floodgate) get distinct UUIDs; usernames are NEVER treated
-- as identity — same-name Java and Bedrock accounts stay separate rows.
CREATE TABLE players (
    id            BIGSERIAL PRIMARY KEY,
    uuid          UUID NOT NULL UNIQUE,
    username      TEXT NOT NULL,
    edition       TEXT NOT NULL DEFAULT 'java'
                  CHECK (edition IN ('java', 'bedrock')),
    first_join    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_date  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_date  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_players_username ON players (lower(username));
CREATE INDEX idx_players_last_seen ON players (last_seen DESC);

-- Player stats: denormalized counters for fast leaderboards. Source of truth
-- is kill_events; these are maintained transactionally by ingestion.
CREATE TABLE player_stats (
    player_id         BIGINT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
    kills             INTEGER NOT NULL DEFAULT 0 CHECK (kills >= 0),
    deaths            INTEGER NOT NULL DEFAULT 0 CHECK (deaths >= 0),
    kill_streak       INTEGER NOT NULL DEFAULT 0,
    longest_streak    INTEGER NOT NULL DEFAULT 0,
    playtime_seconds  BIGINT  NOT NULL DEFAULT 0,
    updated_date      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Kill/death events: append-only ledger. One event row per death.
-- Dedup key event_id guards against plugin retries after restarts.
CREATE TABLE kill_events (
    id            BIGSERIAL PRIMARY KEY,
    event_id      TEXT NOT NULL UNIQUE,          -- plugin-generated UUID (idempotency)
    victim_id     BIGINT NOT NULL REFERENCES players(id),
    killer_id     BIGINT REFERENCES players(id), -- NULL = environment death
    cause         TEXT NOT NULL DEFAULT 'UNKNOWN',
    dimension     TEXT NOT NULL DEFAULT 'overworld'
                  CHECK (dimension IN ('overworld', 'nether', 'the_end')),
    x             INTEGER, y INTEGER, z INTEGER, -- death coordinates
    occurred_at   TIMESTAMPTZ NOT NULL,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_kill_events_victim ON kill_events (victim_id, occurred_at DESC);
CREATE INDEX idx_kill_events_killer ON kill_events (killer_id, occurred_at DESC);
CREATE INDEX idx_kill_events_time  ON kill_events (occurred_at DESC);

-- Trigger: keep updated_date honest
CREATE OR REPLACE FUNCTION touch_updated_date() RETURNS trigger AS $$
BEGIN
    NEW.updated_date = now();
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER players_touch BEFORE UPDATE ON players
    FOR EACH ROW EXECUTE FUNCTION touch_updated_date();
CREATE TRIGGER player_stats_touch BEFORE UPDATE ON player_stats
    FOR EACH ROW EXECUTE FUNCTION touch_updated_date();

-- Leaderboard indexes (added during Step 3)
CREATE INDEX IF NOT EXISTS idx_stats_kills ON player_stats (kills DESC);
CREATE INDEX IF NOT EXISTS idx_stats_deaths ON player_stats (deaths DESC);
CREATE INDEX IF NOT EXISTS idx_stats_streak ON player_stats (kill_streak DESC);
CREATE INDEX IF NOT EXISTS idx_stats_longest ON player_stats (longest_streak DESC);
CREATE INDEX IF NOT EXISTS idx_stats_playtime ON player_stats (playtime_seconds DESC);
