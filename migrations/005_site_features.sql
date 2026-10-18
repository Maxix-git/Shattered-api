-- 005 — Site community features: factions, bounties, community wall,
-- donations, notifications, appeals, player privacy. Backs the TanStack
-- Start website's /api/site/rpc contract (ops: live, me, act).

-- Factions (Discord-owned groups). Members join by Discord id + optional MC name.
CREATE TABLE IF NOT EXISTS factions (
    id               BIGSERIAL PRIMARY KEY,
    name             TEXT NOT NULL UNIQUE,
    tag              TEXT NOT NULL DEFAULT '—',
    description      TEXT NOT NULL DEFAULT 'No description yet.',
    owner_discord_id TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_factions_owner ON factions (owner_discord_id);

CREATE TABLE IF NOT EXISTS faction_members (
    faction_id BIGINT NOT NULL REFERENCES factions(id) ON DELETE CASCADE,
    discord_id TEXT NOT NULL,
    mc_name    TEXT,
    role       TEXT NOT NULL DEFAULT 'member',  -- member | officer | owner
    joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (faction_id, discord_id)
);
CREATE INDEX IF NOT EXISTS idx_faction_members_discord ON faction_members (discord_id);

-- Bounties: a player posts a mark for Honor; the killer claims it.
CREATE TABLE IF NOT EXISTS bounties (
    id                BIGSERIAL PRIMARY KEY,
    target_username   TEXT NOT NULL,
    poster_discord_id TEXT NOT NULL,
    poster_name       TEXT NOT NULL,
    reward            INTEGER NOT NULL DEFAULT 100,
    status            TEXT NOT NULL DEFAULT 'open',  -- open | claimed
    claimed_by        TEXT,
    claimed_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bounties_open ON bounties (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bounties_target ON bounties (target_username);

-- Community wall. Replies use parent_id (NULL = top-level post).
CREATE TABLE IF NOT EXISTS community_posts (
    id         BIGSERIAL PRIMARY KEY,
    parent_id  BIGINT REFERENCES community_posts(id) ON DELETE CASCADE,
    discord_id TEXT NOT NULL,
    author     TEXT NOT NULL,
    category   TEXT NOT NULL DEFAULT 'Community',
    title      TEXT,
    body       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_posts_parent ON community_posts (parent_id);
CREATE INDEX IF NOT EXISTS idx_posts_recent ON community_posts (created_at DESC);

-- Donations: admin records a donation; 30 days ad-free per donation.
CREATE TABLE IF NOT EXISTS donations (
    id          BIGSERIAL PRIMARY KEY,
    discord_id  TEXT,
    mc_name     TEXT,
    amount      NUMERIC(10,2) NOT NULL DEFAULT 0,
    recorded_by TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_donations_discord ON donations (discord_id, created_at DESC);

-- Notifications (per Discord user).
CREATE TABLE IF NOT EXISTS notifications (
    id          BIGSERIAL PRIMARY KEY,
    discord_id  TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'info',
    body        TEXT NOT NULL,
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifs_discord ON notifications (discord_id, created_at DESC);

-- Appeals (ban / report appeals submitted from the dashboard).
CREATE TABLE IF NOT EXISTS appeals (
    id          BIGSERIAL PRIMARY KEY,
    discord_id  TEXT NOT NULL,
    punishment  TEXT NOT NULL,
    mc_name     TEXT,
    reason      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Player privacy toggles (set from the dashboard by the linked account).
ALTER TABLE players ADD COLUMN IF NOT EXISTS profile_public BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE players ADD COLUMN IF NOT EXISTS inventory_public BOOLEAN NOT NULL DEFAULT false;
