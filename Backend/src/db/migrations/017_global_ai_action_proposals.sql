CREATE TABLE IF NOT EXISTS global_ai_action_proposals (
  id UUID PRIMARY KEY,
  idempotency_key UUID NOT NULL UNIQUE,
  request_id UUID,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id BIGINT REFERENCES ai_chat_sessions(id) ON DELETE SET NULL,
  operation VARCHAR(64) NOT NULL,
  arguments JSONB NOT NULL,
  context_type VARCHAR(20),
  context_id BIGINT,
  organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
  summary TEXT NOT NULL,
  target JSONB NOT NULL DEFAULT '{}'::jsonb,
  changes JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(16) NOT NULL DEFAULT 'PROPOSED'
    CHECK (status IN ('PROPOSED', 'APPROVED', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  executing_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result JSONB,
  error_summary TEXT,
  CONSTRAINT global_ai_action_proposal_operation CHECK (
    operation IN ('create_organization', 'create_project', 'create_task', 'update_current_task')
  ),
  CONSTRAINT global_ai_action_proposal_context CHECK (
    (context_type IS NULL AND context_id IS NULL)
    OR (context_type IN ('organization', 'project', 'task') AND context_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_global_ai_action_proposals_request
  ON global_ai_action_proposals(user_id, request_id)
  WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_global_ai_action_proposals_user_status
  ON global_ai_action_proposals(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_global_ai_action_proposals_session
  ON global_ai_action_proposals(session_id, created_at DESC);
