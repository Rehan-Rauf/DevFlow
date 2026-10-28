const pool = require("../config/database");
const { createEmbedding, toVectorLiteral } = require("./embeddingService");
const { assertTaskAccess } = require("./retrievalService");

const MEMORY_TYPES = ["preference", "decision", "requirement", "constraint", "context", "plan", "fact"];
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";
const SENSITIVE_MEMORY_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passphrase|api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|secret|bearer)\b\s*(?:is|=|:)\s*\S+|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b)/i;

function memoryError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function containsSensitiveMemory(content) {
  return SENSITIVE_MEMORY_PATTERN.test(String(content || ""));
}

async function resolveScope(userId, scope = {}) {
  const taskId = scope.taskId == null ? null : Number(scope.taskId);
  const projectId = scope.projectId == null ? null : Number(scope.projectId);
  const organizationId = scope.organizationId == null ? null : Number(scope.organizationId);

  if (taskId !== null) {
    const authorized = await assertTaskAccess(userId, taskId);
    if (projectId !== null && String(projectId) !== String(authorized.projectId)) throw memoryError("Task does not belong to this project.", 403);
    if (organizationId !== null && String(organizationId) !== String(authorized.organizationId)) throw memoryError("Task does not belong to this organization.", 403);
    return authorized;
  }

  if (projectId !== null) {
    const result = await pool.query(
      `SELECT p.id AS "projectId", p.organization_id AS "organizationId"
       FROM projects p
       JOIN organization_members om ON om.organization_id = p.organization_id
       WHERE p.id = $1 AND om.user_id = $2
         AND (
           om.role = 'owner'
           OR EXISTS (
             SELECT 1 FROM project_members pm
             WHERE pm.project_id = p.id AND pm.user_id = $2
           )
         )`,
      [projectId, userId],
    );
    if (!result.rowCount) throw memoryError("You do not have access to this project.", 403);
    if (organizationId !== null && Number(result.rows[0].organizationId) !== organizationId) throw memoryError("Project does not belong to this organization.", 403);
    return result.rows[0];
  }

  if (organizationId !== null) {
    const result = await pool.query(
      `SELECT organization_id AS "organizationId" FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId],
    );
    if (!result.rowCount) throw memoryError("You are not a member of this organization.", 403);
    return result.rows[0];
  }

  return { taskId: null, projectId: null, organizationId: null };
}

function normalizeType(type) {
  if (!MEMORY_TYPES.includes(type)) throw memoryError("Invalid memory type.");
  return type;
}

async function embedOrNull(content) {
  try {
    return toVectorLiteral(await createEmbedding(content));
  } catch (error) {
    console.error("Memory embedding unavailable:", error.message);
    return null;
  }
}

function rowToMemory(row) {
  return {
    id: row.id,
    userId: row.user_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    taskId: row.task_id,
    type: row.type,
    content: row.content,
    importance: row.importance,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const MEMORY_VISIBILITY_FILTER = `(
  (
    m.organization_id IS NULL AND m.project_id IS NULL AND m.task_id IS NULL
    AND m.user_id = $1
  )
  OR (
    m.organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.organization_id = m.organization_id AND om.user_id = $1
    )
    AND (
      (m.project_id IS NULL AND m.task_id IS NULL)
      OR (
        m.project_id IS NOT NULL AND m.task_id IS NULL
        AND (
          EXISTS (
            SELECT 1 FROM organization_members owner
            WHERE owner.organization_id = m.organization_id
              AND owner.user_id = $1 AND owner.role = 'owner'
          )
          OR EXISTS (
            SELECT 1 FROM project_members pm
            WHERE pm.project_id = m.project_id AND pm.user_id = $1
          )
        )
      )
      OR (
        m.task_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM tasks t
          JOIN projects p ON p.id = t.project_id
          WHERE t.id = m.task_id
            AND p.organization_id = m.organization_id
            AND (
              EXISTS (
                SELECT 1 FROM organization_members owner
                WHERE owner.organization_id = p.organization_id
                  AND owner.user_id = $1 AND owner.role = 'owner'
              )
              OR EXISTS (
                SELECT 1 FROM project_members pm
                WHERE pm.project_id = p.id AND pm.user_id = $1
                  AND pm.role = 'project_admin'
              )
              OR (
                t.assignee_id = $1
                AND EXISTS (
                  SELECT 1 FROM project_members pm
                  WHERE pm.project_id = p.id AND pm.user_id = $1
                )
              )
            )
        )
      )
    )
  )
)`;

async function createMemory({ userId, type, content, importance = 5, metadata = {}, ...scope }) {
  const cleanContent = String(content || "").trim();
  if (!cleanContent) throw memoryError("Memory content is required.");
  if (containsSensitiveMemory(cleanContent)) {
    throw memoryError("Credentials and secrets cannot be saved as AI memory.");
  }
  normalizeType(type);
  const resolved = await resolveScope(userId, scope);
  const existing = await pool.query(
    `SELECT id FROM ai_memories
     WHERE user_id = $1 AND type = $2 AND lower(content) = lower($3)
       AND organization_id IS NOT DISTINCT FROM $4
       AND project_id IS NOT DISTINCT FROM $5
       AND task_id IS NOT DISTINCT FROM $6 LIMIT 1`,
    [userId, type, cleanContent, resolved.organizationId || null, resolved.projectId || null, resolved.taskId || null],
  );
  if (existing.rowCount) return getMemory({ userId, memoryId: existing.rows[0].id });
  const embedding = await embedOrNull(cleanContent);
  const result = await pool.query(
    `INSERT INTO ai_memories (user_id, organization_id, project_id, task_id, type, content, importance, embedding, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9::jsonb) RETURNING *`,
    [userId, resolved.organizationId || null, resolved.projectId || null, resolved.taskId || null, type, cleanContent, Math.max(1, Math.min(10, Number(importance) || 5)), embedding, JSON.stringify(metadata || {})],
  );
  return rowToMemory(result.rows[0]);
}

async function getMemory({ userId, memoryId }) {
  const result = await pool.query(`SELECT * FROM ai_memories WHERE id = $1 AND user_id = $2`, [memoryId, userId]);
  if (!result.rowCount) throw memoryError("Memory not found.", 404);
  return rowToMemory(result.rows[0]);
}

async function listMemories({ userId, type, taskId, projectId, organizationId }) {
  const params = [userId];
  const filters = [];
  if (type) { normalizeType(type); params.push(type); filters.push(`m.type = $${params.length}`); }
  if (taskId != null) {
    const resolved = await resolveScope(userId, { taskId, projectId, organizationId });
    params.push(Number(taskId), Number(resolved.projectId), Number(resolved.organizationId));
    filters.push(`(
      m.task_id = $${params.length - 2}
      OR (m.task_id IS NULL AND m.project_id = $${params.length - 1})
      OR (m.task_id IS NULL AND m.project_id IS NULL AND m.organization_id = $${params.length})
      OR (m.task_id IS NULL AND m.project_id IS NULL AND m.organization_id IS NULL)
    )`);
  } else {
    if (projectId != null) await resolveScope(userId, { projectId, organizationId });
    else if (organizationId != null) await resolveScope(userId, { organizationId });
    for (const [column, value] of [["project_id", projectId], ["organization_id", organizationId]]) {
      if (value != null) { params.push(Number(value)); filters.push(`m.${column} = $${params.length}`); }
    }
  }
  filters.push(MEMORY_VISIBILITY_FILTER);
  const result = await pool.query(`SELECT m.* FROM ai_memories m WHERE ${filters.join(" AND ")} ORDER BY m.updated_at DESC LIMIT 200`, params);
  return result.rows.map(rowToMemory);
}

async function updateMemory({ userId, memoryId, type, content, importance, metadata, ...scope }) {
  const current = await getMemory({ userId, memoryId });
  const nextType = type || current.type;
  normalizeType(nextType);
  const nextContent = content == null ? current.content : String(content).trim();
  if (!nextContent) throw memoryError("Memory content is required.");
  const resolved = await resolveScope(userId, Object.keys(scope).length ? scope : current);
  const embedding = content == null ? null : await embedOrNull(nextContent);
  const result = await pool.query(
    `UPDATE ai_memories SET type=$1, content=$2, importance=$3,
       organization_id=$4, project_id=$5, task_id=$6,
       embedding=COALESCE($7::vector, embedding), metadata=$8::jsonb, updated_at=NOW()
     WHERE id=$9 AND user_id=$10 RETURNING *`,
    [nextType, nextContent, Math.max(1, Math.min(10, Number(importance ?? current.importance) || 5)), resolved.organizationId || null, resolved.projectId || null, resolved.taskId || null, embedding, JSON.stringify(metadata ?? current.metadata), memoryId, userId],
  );
  return rowToMemory(result.rows[0]);
}

async function deleteMemory({ userId, memoryId }) {
  const result = await pool.query(`DELETE FROM ai_memories WHERE id = $1 AND user_id = $2 RETURNING id`, [memoryId, userId]);
  if (!result.rowCount) throw memoryError("Memory not found.", 404);
  return { id: result.rows[0].id };
}

async function clearMemories({ userId }) {
  const result = await pool.query(
    "DELETE FROM ai_memories WHERE user_id = $1 RETURNING id",
    [userId],
  );
  return { deletedCount: result.rowCount };
}

async function forgetMemory({ userId, request, taskId, projectId, organizationId }) {
  const phrase = String(request || "").trim().replace(/^forget(?: memory)?(?: that)?\s+/i, "").trim();
  if (!phrase) throw memoryError("Tell me which memory to forget.");
  const candidates = await listMemories({ userId, taskId, projectId, organizationId });
  const match = candidates.find((memory) =>
    memory.content.toLowerCase().includes(phrase.toLowerCase()) ||
    phrase.toLowerCase().includes(memory.content.toLowerCase()),
  );
  if (!match) return null;
  await deleteMemory({ userId, memoryId: match.id });
  return match;
}

async function searchMemories({ userId, query, taskId, projectId, organizationId, limit = 6 }) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return [];
  const params = [userId];
  const scope = [MEMORY_VISIBILITY_FILTER];
  if (taskId != null) { params.push(Number(taskId)); scope.push(`(m.task_id = $${params.length} OR (m.task_id IS NULL AND (m.project_id IS NULL OR m.project_id = (SELECT project_id FROM tasks WHERE id = $${params.length}))))`); }
  else if (projectId != null) { params.push(Number(projectId)); scope.push(`(m.task_id IS NULL AND (m.project_id IS NULL OR m.project_id = $${params.length}))`); }
  else if (organizationId != null) { params.push(Number(organizationId)); scope.push(`m.task_id IS NULL AND m.project_id IS NULL AND (m.organization_id IS NULL OR m.organization_id = $${params.length})`); }
  const embedding = await embedOrNull(cleanQuery);
  if (embedding) {
    params.push(embedding, Math.min(10, Math.max(1, Number(limit) || 6)));
    const result = await pool.query(`SELECT m.*, (1 - (m.embedding <=> $${params.length - 1}::vector)) AS similarity
      FROM ai_memories m WHERE ${scope.join(" AND ")} AND m.embedding IS NOT NULL
      ORDER BY (1 - (m.embedding <=> $${params.length - 1}::vector)) * 0.7 + (m.importance / 10.0) * 0.2 +
        GREATEST(0, 1 - EXTRACT(EPOCH FROM (NOW() - m.updated_at)) / 31536000.0) * 0.1 DESC LIMIT $${params.length}`, params);
    return result.rows.map((row) => ({ ...rowToMemory(row), similarity: Number(row.similarity) }));
  }
  params.push(`%${cleanQuery}%`, Math.min(10, Math.max(1, Number(limit) || 6)));
  const result = await pool.query(`SELECT m.*, 0.5 AS similarity FROM ai_memories m WHERE ${scope.join(" AND ")} AND m.content ILIKE $${params.length - 1} ORDER BY m.importance DESC, m.updated_at DESC LIMIT $${params.length}`, params);
  return result.rows.map((row) => ({ ...rowToMemory(row), similarity: 0.5 }));
}

async function getRelevantMemories({ userId, query, taskId, projectId, organizationId }) {
  if (taskId != null) await resolveScope(userId, { taskId });
  else if (projectId != null) await resolveScope(userId, { projectId });
  else if (organizationId != null) await resolveScope(userId, { organizationId });
  return searchMemories({ userId, query, taskId, projectId, organizationId, limit: 6 });
}

async function extractCandidates(message) {
  if (!process.env.OPENROUTER_API_KEY || !String(message || "").trim()) return [];
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": process.env.FRONTEND_URL || "http://localhost:5173",
      "X-Title": "DevFlow Memory Extraction",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract only reusable long-term information from the user message.
Do not extract greetings, questions, calculations, temporary debugging details, or one-time requests.
Return only JSON: {"shouldRemember":false,"memories":[]} or
{"shouldRemember":true,"memories":[{"type":"preference|fact|decision|requirement|constraint|context|plan","content":"...","importance":0.0}]}.`,
        },
        { role: "user", content: String(message).trim() },
      ],
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Memory extraction failed.");
  const content = data?.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(content.replace(/^```json\s*|\s*```$/g, ""));
  if (parsed.shouldRemember !== true || !Array.isArray(parsed.memories)) return [];
  return parsed.memories
    .filter((candidate) =>
      MEMORY_TYPES.includes(candidate.type) &&
      String(candidate.content || "").trim() &&
      Number(candidate.importance) >= 0.5,
    )
    .slice(0, 3);
}

async function extractMemoriesFromConversation({ userId, message, taskId, projectId, organizationId }) {
  const match = String(message || "").trim().match(/^(?:remember(?: that)?|don't forget(?: that)?)\s+(.+)/i);
  let candidates;
  if (match) {
    if (containsSensitiveMemory(match[1])) {
      throw memoryError("Credentials and secrets cannot be saved as AI memory.");
    }
    const content = match[1].trim();
    candidates = [{
      type: /\b(prefer|preference|like)\b/i.test(content) ? "preference"
        : /\b(requirement|required|must)\b/i.test(content) ? "requirement"
          : /\b(decid|use|migrat)\b/i.test(content) ? "decision" : "context",
      content,
      importance: 1,
    }];
  } else {
    try {
      candidates = await extractCandidates(message);
    } catch (error) {
      console.error("Memory extraction failed; continuing without memory:", error.message);
      return [];
    }
  }
  const saved = [];
  for (const candidate of candidates) {
    if (containsSensitiveMemory(candidate.content)) continue;
    const created = await createMemory({
      userId,
      type: candidate.type,
      content: candidate.content,
      importance: Math.round(Math.max(1, Math.min(10, Number(candidate.importance) * 10))),
      taskId,
      projectId,
      organizationId,
      metadata: { source: match ? "explicit" : "automatic" },
    });
    saved.push(created);
  }
  return saved;
}

function isExplicitMemoryCommand(message) {
  return /^(?:remember(?: that)?|don't forget(?: that)?)\s+/i.test(String(message || "").trim());
}

function isForgetMemoryCommand(message) {
  return /^forget(?: memory)?(?: that)?\s+/i.test(String(message || "").trim());
}

module.exports = {
  MEMORY_TYPES,
  createMemory,
  updateMemory,
  deleteMemory,
  clearMemories,
  forgetMemory,
  getMemory,
  listMemories,
  searchMemories,
  getRelevantMemories,
  extractMemoriesFromConversation,
  isExplicitMemoryCommand,
  isForgetMemoryCommand,
  containsSensitiveMemory,
};
