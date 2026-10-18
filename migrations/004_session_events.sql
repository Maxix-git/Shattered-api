-- 004 — Session event ledger for the Discord bot feed.
-- Joins/quits are kept append-only (dedup by event_id) so the bot can
-- poll them for announcements. Kills already live in kill_events.
CREATE TABLE IF NOT EXISTS session_events (
    id            BIGSERIAL PRIMARY KEY,
    event_id      TEXT NOT NULL UNIQUE,
    type          TEXT NOT NULL CHECK (type IN ('player_join', 'player_quit')),
    uuid          UUID NOT NULL,
    username      TEXT NOT NULL,
    session_seconds INTEGER,
    occurred_at   TIMESTAMPTZ NOT NULL,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_events_time ON session_events (id DESC);
