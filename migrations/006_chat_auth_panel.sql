--- 006 — Chat bridge, offline-mode auth registry, birthdays, avatars,
--- server-panel bookkeeping. Backs the two-way #server-chat bridge, the
--- offline/Bedrock link-gate, and the admin Server tab.

-- Two-way chat bridge. direction: 'mc' = in-game message shown in Discord,
-- 'discord' = Discord message broadcast in-game, 'broadcast' = system
-- broadcast the plugin shows to everyone in-game.
CREATE TABLE IF NOT EXISTS chat_messages (
    id          BIGSERIAL PRIMARY KEY,
    direction   TEXT NOT NULL CHECK (direction IN ('mc', 'discord', 'broadcast')),
    mc_name     TEXT,
    discord_id  TEXT,
    author      TEXT,
    body        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages (id, direction);

-- Username registry: one MC name = one identity. auth_type 'mojang' means a
-- premium account (verified by name lookup, first-claim-wins), 'discord'
-- means the name is owned by a linked Discord account.
CREATE TABLE IF NOT EXISTS name_registry (
    mc_name     TEXT PRIMARY KEY,
    auth_type   TEXT NOT NULL CHECK (auth_type IN ('mojang', 'discord')),
    discord_id  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE players ADD COLUMN IF NOT EXISTS birthday   TEXT;      -- 'MM-DD'
ALTER TABLE players ADD COLUMN IF NOT EXISTS avatar_url  TEXT;      -- data URL or https
ALTER TABLE players ADD COLUMN IF NOT EXISTS in_limbo    BOOLEAN NOT NULL DEFAULT false;

-- One birthday post per player per day (idempotent daily announcements).
CREATE TABLE IF NOT EXISTS birthday_posts (
    player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    posted_on  DATE   NOT NULL,
    PRIMARY KEY (player_id, posted_on)
);
