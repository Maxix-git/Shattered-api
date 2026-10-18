-- 002 — Server heartbeat history. Plugin posts every ~30s; status route reads latest row.
CREATE TABLE IF NOT EXISTS server_status (
    id            BIGSERIAL PRIMARY KEY,
    online_players INTEGER NOT NULL CHECK (online_players >= 0),
    max_players   INTEGER NOT NULL CHECK (max_players >= 0),
    tps           DOUBLE PRECISION NOT NULL CHECK (tps >= 0),
    motd          TEXT NOT NULL DEFAULT '',
    version       TEXT NOT NULL DEFAULT '',
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_server_status_recorded ON server_status (recorded_at DESC);
