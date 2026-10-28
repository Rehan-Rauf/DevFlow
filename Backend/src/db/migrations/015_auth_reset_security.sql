ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_auth_version_nonnegative'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_auth_version_nonnegative CHECK (auth_version >= 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS password_reset_rate_limits (
  bucket VARCHAR(16) NOT NULL CHECK (bucket IN ('email', 'ip')),
  key_hash CHAR(64) NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count > 0),
  PRIMARY KEY (bucket, key_hash)
);

CREATE INDEX IF NOT EXISTS password_reset_rate_limits_window_idx
  ON password_reset_rate_limits (window_started_at);

CREATE TABLE IF NOT EXISTS auth_security_events (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(40) NOT NULL CHECK (
    event_type IN (
      'password_reset_requested',
      'password_reset_rate_limited',
      'password_reset_rejected',
      'password_reset_completed'
    )
  ),
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  subject_hash CHAR(64),
  source_hash CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_security_events_user_idx
  ON auth_security_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS auth_security_events_created_idx
  ON auth_security_events (created_at);

CREATE TABLE IF NOT EXISTS task_agent_confirmations (
  jti UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id BIGINT NOT NULL,
  action VARCHAR(40) NOT NULL CHECK (action = 'delete_task'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS task_agent_confirmations_expiry_idx
  ON task_agent_confirmations (expires_at);

CREATE TABLE IF NOT EXISTS task_agent_tool_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
  tool_name VARCHAR(80) NOT NULL,
  outcome VARCHAR(32) NOT NULL CHECK (
    outcome IN ('started', 'succeeded', 'failed', 'confirmation_required')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS task_agent_tool_events_task_idx
  ON task_agent_tool_events (task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS task_agent_tool_events_user_idx
  ON task_agent_tool_events (user_id, created_at DESC);
