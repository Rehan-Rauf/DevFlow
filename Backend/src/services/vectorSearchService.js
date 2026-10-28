// ============================================================
// VECTOR SEARCH SERVICE
// ============================================================
//
// Semantic search also enforces the current user's resource-level visibility
// so organization membership alone cannot expose private task/comment content.
// ============================================================

const pool = require("../config/database");
const { createEmbedding, toVectorLiteral } = require("./embeddingService");

async function searchKnowledge({
  query,
  userId,
  organizationId,
  projectId = null,
  taskId = null,
  sourceTypes = null, // e.g. ["task", "comment"]
  limit = 8,
}) {
  if (!query || !String(query).trim()) {
    throw new Error("Search query is required.");
  }

  if (!organizationId || !userId) {
    throw new Error("Authenticated user and organization IDs are required.");
  }

  const embedding = await createEmbedding(query);
  const vector = toVectorLiteral(embedding);

  const result = await pool.query(
    `
    SELECT
      id,
      organization_id,
      project_id,
      task_id,
      comment_id,
      source_type,
      source_id,
      content,
      metadata,
      1 - (embedding <=> $1::vector) AS similarity
    FROM knowledge_embeddings
    WHERE organization_id = $2
      AND EXISTS (
        SELECT 1 FROM organization_members om
        WHERE om.organization_id = knowledge_embeddings.organization_id
          AND om.user_id = $7
      )
      AND (
        source_type = 'organization'
        OR (
          source_type = 'project'
          AND EXISTS (
            SELECT 1 FROM projects p
            WHERE p.id = knowledge_embeddings.project_id
              AND (
                EXISTS (
                  SELECT 1 FROM organization_members om
                  WHERE om.organization_id = p.organization_id
                    AND om.user_id = $7 AND om.role = 'owner'
                )
                OR EXISTS (
                  SELECT 1 FROM project_members pm
                  WHERE pm.project_id = p.id AND pm.user_id = $7
                )
              )
          )
        )
        OR (
          source_type IN ('task', 'comment')
          AND EXISTS (
            SELECT 1
            FROM tasks t
            JOIN projects p ON p.id = t.project_id
            WHERE t.id = knowledge_embeddings.task_id
              AND (
                EXISTS (
                  SELECT 1 FROM organization_members om
                  WHERE om.organization_id = p.organization_id
                    AND om.user_id = $7 AND om.role = 'owner'
                )
                OR EXISTS (
                  SELECT 1 FROM project_members pm
                  WHERE pm.project_id = p.id AND pm.user_id = $7
                    AND pm.role = 'project_admin'
                )
                OR (
                  t.assignee_id = $7
                  AND EXISTS (
                    SELECT 1 FROM project_members pm
                    WHERE pm.project_id = p.id AND pm.user_id = $7
                  )
                )
              )
          )
        )
      )
      AND ($3::bigint IS NULL OR project_id = $3 OR project_id IS NULL)
      AND ($4::bigint IS NULL OR task_id = $4)
      AND ($5::text[] IS NULL OR source_type = ANY($5::text[]))
      AND embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT $6
    `,
    [vector, organizationId, projectId, taskId, sourceTypes, limit, userId]
  );

  return result.rows;
}

async function searchKnowledgeAcrossOrganizations({
  query,
  userId,
  organizationIds,
  sourceTypes = null,
  limit = 8,
}) {
  if (!query || !String(query).trim()) {
    throw new Error("Search query is required.");
  }

  if (!userId || !Array.isArray(organizationIds) || organizationIds.length === 0) {
    return [];
  }

  const embedding = await createEmbedding(query);
  const vector = toVectorLiteral(embedding);

  const result = await pool.query(
    `
    SELECT
      id,
      organization_id,
      project_id,
      task_id,
      comment_id,
      source_type,
      source_id,
      content,
      metadata,
      1 - (embedding <=> $1::vector) AS similarity
    FROM knowledge_embeddings
    WHERE organization_id = ANY($2::bigint[])
      AND EXISTS (
        SELECT 1 FROM organization_members om
        WHERE om.organization_id = knowledge_embeddings.organization_id
          AND om.user_id = $5
      )
      AND (
        source_type = 'organization'
        OR (
          source_type = 'project'
          AND EXISTS (
            SELECT 1 FROM projects p
            WHERE p.id = knowledge_embeddings.project_id
              AND (
                EXISTS (
                  SELECT 1 FROM organization_members om
                  WHERE om.organization_id = p.organization_id
                    AND om.user_id = $5 AND om.role = 'owner'
                )
                OR EXISTS (
                  SELECT 1 FROM project_members pm
                  WHERE pm.project_id = p.id AND pm.user_id = $5
                )
              )
          )
        )
        OR (
          source_type IN ('task', 'comment')
          AND EXISTS (
            SELECT 1
            FROM tasks t
            JOIN projects p ON p.id = t.project_id
            WHERE t.id = knowledge_embeddings.task_id
              AND (
                EXISTS (
                  SELECT 1 FROM organization_members om
                  WHERE om.organization_id = p.organization_id
                    AND om.user_id = $5 AND om.role = 'owner'
                )
                OR EXISTS (
                  SELECT 1 FROM project_members pm
                  WHERE pm.project_id = p.id AND pm.user_id = $5
                    AND pm.role = 'project_admin'
                )
                OR (
                  t.assignee_id = $5
                  AND EXISTS (
                    SELECT 1 FROM project_members pm
                    WHERE pm.project_id = p.id AND pm.user_id = $5
                  )
                )
              )
          )
        )
      )
      AND ($3::text[] IS NULL OR source_type = ANY($3::text[]))
      AND embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT $4
    `,
    [vector, organizationIds, sourceTypes, limit, userId]
  );

  return result.rows;
}

module.exports = {
  searchKnowledge,
  searchKnowledgeAcrossOrganizations,
};
