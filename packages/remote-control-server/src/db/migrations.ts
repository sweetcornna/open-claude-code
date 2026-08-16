import type { Database } from 'bun:sqlite'

interface Migration {
  version: number
  up: (db: Database) => void
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          disabled_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE auth_tokens (
          digest TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh', 'browser', 'pair')),
          session_id TEXT,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          revoked_at INTEGER,
          replaced_by_digest TEXT
        );

        CREATE INDEX auth_tokens_account_kind_idx
          ON auth_tokens(account_id, kind, expires_at);
        CREATE INDEX auth_tokens_session_idx
          ON auth_tokens(account_id, session_id, kind);
      `)
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE environments (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          credential_digest TEXT NOT NULL UNIQUE,
          machine_name TEXT,
          directory TEXT,
          branch TEXT,
          git_repo_url TEXT,
          max_sessions INTEGER NOT NULL,
          worker_type TEXT NOT NULL,
          bridge_id TEXT,
          capabilities_json TEXT,
          status TEXT NOT NULL,
          last_poll_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX environments_account_status_idx
          ON environments(account_id, status);
        CREATE INDEX environments_account_bridge_idx
          ON environments(account_id, bridge_id);

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
          title TEXT,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          permission_mode TEXT,
          worker_epoch INTEGER NOT NULL DEFAULT 0,
          next_event_seq INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX sessions_account_updated_idx
          ON sessions(account_id, updated_at DESC);
        CREATE INDEX sessions_account_environment_idx
          ON sessions(account_id, environment_id);

        CREATE TABLE work_items (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          state TEXT NOT NULL,
          credential_digest TEXT UNIQUE,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX work_items_account_environment_state_idx
          ON work_items(account_id, environment_id, state, created_at);

        CREATE TABLE session_workers (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          worker_status TEXT,
          external_metadata_json TEXT,
          requires_action_details_json TEXT,
          last_heartbeat_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE events (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          seq_num INTEGER NOT NULL,
          id TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, seq_num)
        );

        CREATE INDEX events_account_session_seq_idx
          ON events(account_id, session_id, seq_num);

        CREATE TABLE rate_limit_buckets (
          bucket_key TEXT PRIMARY KEY,
          count INTEGER NOT NULL,
          window_started_at INTEGER NOT NULL
        );
      `)
    },
  },
]
