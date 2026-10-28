-- ============================================================
-- CMS KNOWLEDGE / RAG SCHEMA FIX
-- ============================================================
--
-- PROBLEM BEING FIXED:
--
-- Migration 002 created a table called `knowledge_base`
-- (entity_type / entity_id / embedding VECTOR(1536)).
--
-- But the actual application code (knowledgeBaseService.js,
-- vectorSearchService.js) reads/writes a DIFFERENT table
-- called `knowledge_embeddings` (source_type / source_id /
-- project_id / task_id / comment_id) which was never created.
--
-- Result: every embedding insert and every vector search
-- throws "relation knowledge_embeddings does not exist".
--
-- This migration creates the knowledge table used by the code, while retaining
-- the original knowledge_base table for installations that may still have data.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- Keep the legacy knowledge_base table intact. Even if current application
-- code no longer reads it, dropping it here would destroy data on every
-- migration run for installations that still have records in it.


-- ============================================================
-- KNOWLEDGE EMBEDDINGS (single source of truth)
-- ============================================================

CREATE TABLE IF NOT EXISTS knowledge_embeddings (
    id BIGSERIAL PRIMARY KEY,

    -- Scope hierarchy. organization_id is always set.
    -- project_id / task_id / comment_id are set when relevant
    -- so retrieval can be filtered/authorized at any level.
    organization_id BIGINT NOT NULL
        REFERENCES organizations(id) ON DELETE CASCADE,

    project_id BIGINT
        REFERENCES projects(id) ON DELETE CASCADE,

    task_id BIGINT
        REFERENCES tasks(id) ON DELETE CASCADE,

    comment_id BIGINT
        REFERENCES task_comments(id) ON DELETE CASCADE,

    -- organization | project | task | comment
    source_type VARCHAR(30) NOT NULL
        CHECK (source_type IN ('organization', 'project', 'task', 'comment')),

    -- id of the row in its own table (organizations.id, tasks.id, etc.)
    source_id BIGINT NOT NULL,

    -- Large content is split into chunks. Simple records are chunk 0.
    chunk_index INTEGER NOT NULL DEFAULT 0,

    content TEXT NOT NULL,

    -- sha256 of `content`, used to skip re-embedding unchanged data.
    content_hash VARCHAR(64) NOT NULL,

    embedding VECTOR(1536),

    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Idempotent upsert target: re-indexing the same source
    -- updates the existing row instead of duplicating it.
    CONSTRAINT unique_knowledge_source
        UNIQUE (source_type, source_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_organization
    ON knowledge_embeddings(organization_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_project
    ON knowledge_embeddings(project_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_task
    ON knowledge_embeddings(task_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_source
    ON knowledge_embeddings(source_type, source_id);

-- Vector similarity index (cosine distance).
CREATE INDEX IF NOT EXISTS idx_knowledge_embedding_hnsw
    ON knowledge_embeddings
    USING hnsw (embedding vector_cosine_ops);

DROP TRIGGER IF EXISTS knowledge_embeddings_updated_at_trigger
    ON knowledge_embeddings;

CREATE TRIGGER knowledge_embeddings_updated_at_trigger
BEFORE UPDATE ON knowledge_embeddings
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();


-- ============================================================
-- SCOPED AI CHAT MEMORY (Task AI, for now)
-- ============================================================
--
-- One row per message. Scoped by (task_id, user_id) so two
-- different users chatting about the same task never see
-- each other's conversation, and a task conversation never
-- leaks into another task's conversation.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_task_messages (
    id BIGSERIAL PRIMARY KEY,

    task_id BIGINT NOT NULL
        REFERENCES tasks(id) ON DELETE CASCADE,

    user_id BIGINT NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,

    role VARCHAR(20) NOT NULL
        CHECK (role IN ('user', 'assistant')),

    content TEXT NOT NULL,

    -- Sources shown under an assistant message (task/comment refs).
    sources JSONB NOT NULL DEFAULT '[]'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_task_messages_scope
    ON ai_task_messages(task_id, user_id, created_at);
