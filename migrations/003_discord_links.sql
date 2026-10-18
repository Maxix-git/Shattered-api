-- Step 5: Discord account linking + sessions for the website.
CREATE TABLE IF NOT EXISTS discord_links (
    player_id        BIGINT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
    discord_id       TEXT NOT NULL UNIQUE,
    discord_username TEXT NOT NULL DEFAULT '',
    linked_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS link_codes (
    code       TEXT PRIMARY KEY,
    player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    claimed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_link_codes_expiry ON link_codes (expires_at);

CREATE TABLE IF NOT EXISTS link_sessions (
    token            TEXT PRIMARY KEY,
    discord_id       TEXT NOT NULL,
    discord_username TEXT NOT NULL DEFAULT '',
    expires_at       TIMESTAMPTZ NOT NULL
);
