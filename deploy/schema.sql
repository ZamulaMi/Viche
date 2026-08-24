-- Viche · PostgreSQL schema
CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alias       TEXT NOT NULL,
    ip_hash     TEXT NOT NULL,
    preferences JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
    id          BIGSERIAL PRIMARY KEY,
    target_ip   TEXT NOT NULL,
    reporter_ip TEXT NOT NULL,
    reason      TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_target_idx ON reports (target_ip, created_at DESC);

CREATE TABLE IF NOT EXISTS rooms (
    id          TEXT PRIMARY KEY,            -- VCH-XXXXXX
    name        TEXT NOT NULL,
    admin_id    UUID REFERENCES users(id),
    seats       INT NOT NULL DEFAULT 4,
    tags        TEXT[] NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at   TIMESTAMPTZ
);
