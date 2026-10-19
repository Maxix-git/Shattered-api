-- 007: Owner console — server announcements queue, appeal resolutions,
-- bounty management from the web dashboard.

CREATE TABLE IF NOT EXISTS announcements (
    id          BIGSERIAL PRIMARY KEY,
    author      TEXT NOT NULL,
    body        TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'web',   -- web | discord
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    posted_at   TIMESTAMPTZ                     -- NULL = waiting for the bot
);
CREATE INDEX IF NOT EXISTS idx_announcements_pending ON announcements (posted_at, id);

-- Appeals: owners resolve them from the dashboard; the appellant gets a
-- notification either way.
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS resolved_by TEXT;
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS resolution TEXT;    -- accepted | denied
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- Bounties may now also be 'cancelled' by their poster (status was open|claimed).
CREATE INDEX IF NOT EXISTS idx_bounties_poster ON bounties (poster_discord_id, status);
