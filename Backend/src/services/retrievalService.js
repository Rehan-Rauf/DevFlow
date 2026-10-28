// ============================================================
// RETRIEVAL SERVICE
// ============================================================
//
// The ONLY entry point AI code should use to gather task
// context. Enforces the rule from spec section 19:
//
//   User -> Authentication -> Authorization -> Scope validation
//        -> Database/vector retrieval -> AI
//
// Never trust a taskId/projectId/organizationId that arrives
// from the frontend without checking membership here first.
// ============================================================

const pool = require("../config/database");
const { searchKnowledge, searchKnowledgeAcrossOrganizations } = require("./vectorSearchService");

// ============================================================
// AUTHORIZATION
// ============================================================
//
// Throws a tagged error (err.status) if the user cannot access
// this task. Returns the task's project/organization ids so
// downstream code can also use them (never re-trust the body).

async function assertTaskAccess(userId, taskId) {
  const result = await pool.query(
    `
    SELECT
      t.id AS task_id,
      p.id AS project_id,
      o.id AS organization_id,
      t.assignee_id,
      EXISTS (
        SELECT 1 FROM organization_members om
        WHERE om.organization_id = p.organization_id
          AND om.user_id = $1
      ) AS is_org_member,
      EXISTS (
        SELECT 1 FROM organization_members om
        WHERE om.organization_id = p.organization_id
          AND om.user_id = $1
          AND om.role = 'owner'
      ) AS is_org_owner,
      EXISTS (
        SELECT 1 FROM project_members pm
        WHERE pm.project_id = p.id
          AND pm.user_id = $1
          AND pm.role = 'project_admin'
          AND EXISTS (
            SELECT 1 FROM organization_members om
            WHERE om.organization_id = p.organization_id
              AND om.user_id = pm.user_id
          )
      ) AS is_project_admin,
      EXISTS (
        SELECT 1 FROM project_members pm
        WHERE pm.project_id = p.id
          AND pm.user_id = $1
          AND EXISTS (
            SELECT 1 FROM organization_members om
            WHERE om.organization_id = p.organization_id
              AND om.user_id = pm.user_id
          )
      ) AS is_project_member
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN organizations o ON o.id = p.organization_id
    WHERE t.id = $2
    `,
    [userId, taskId]
  );

  if (!result.rowCount) {
    const error = new Error("Task not found.");
    error.status = 404;
    throw error;
  }

  const row = result.rows[0];

  const canViewTask = row.is_org_member && (
    row.is_org_owner
    || row.is_project_admin
    || (row.is_project_member && Number(row.assignee_id) === Number(userId))
  );

  if (!canViewTask) {
    const error = new Error("You do not have access to this task.");
    error.status = 403;
    throw error;
  }

  return {
    taskId: row.task_id,
    projectId: row.project_id,
    organizationId: row.organization_id,
  };
}

// ============================================================
// STRUCTURED TASK FACTS (direct SQL - always accurate)
// ============================================================
//
// These are FACTS, not retrieved/semantic guesses. The AI
// prompt keeps these clearly separated from anything pulled
// from vector search (spec section 63).

async function getTaskFacts(taskId) {
  const taskResult = await pool.query(
    `
    SELECT
      t.id, t.title, t.description, t.status, t.priority,
      t.due_date, t.created_at, t.updated_at,
      p.id AS project_id, p.name AS project_name,
      o.id AS organization_id, o.name AS organization_name,
      assignee.name AS assignee_name,
      creator.name AS creator_name
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN organizations o ON o.id = p.organization_id
    LEFT JOIN users assignee ON assignee.id = t.assignee_id
    JOIN users creator ON creator.id = t.created_by
    WHERE t.id = $1
    `,
    [taskId]
  );

  if (!taskResult.rowCount) return null;
  const task = taskResult.rows[0];

  const commentsResult = await pool.query(
    `
    SELECT c.id, c.content, c.created_at, u.name AS user_name
    FROM task_comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.task_id = $1
    ORDER BY c.created_at DESC
    LIMIT 15
    `,
    [taskId]
  );

  const activityResult = await pool.query(
    `
    SELECT id, action, old_value, new_value, created_at
    FROM task_activity
    WHERE task_id = $1
    ORDER BY created_at DESC
    LIMIT 15
    `,
    [taskId]
  );

  const isOverdue =
    task.due_date &&
    task.status !== "done" &&
    task.status !== "cancelled" &&
    new Date(task.due_date) < new Date();

  return {
    task,
    isOverdue: Boolean(isOverdue),
    comments: commentsResult.rows,
    activity: activityResult.rows,
  };
}

// ============================================================
// STRUCTURED PROJECT FACTS
// ============================================================
//
// Gets project information for an already-authorized project.
// projectId comes from assertTaskAccess(), not directly from
// the frontend request body.
// ============================================================

async function getProjectFacts(projectId) {
  const result = await pool.query(
    `
    SELECT
      p.id,
      p.name,
      p.organization_id,
      o.name AS organization_name
    FROM projects p
    JOIN organizations o
      ON o.id = p.organization_id
    WHERE p.id = $1
    `,
    [projectId]
  );

  if (!result.rowCount) {
    return null;
  }

  return {
    project: result.rows[0]
  };
}

// ============================================================
// HYBRID CONTEXT FOR TASK AI CHAT
// ============================================================
//
// Combines structured facts (always included, always correct)
// with a semantic search restricted to this task's organization
// and project, so long/older comments or related discussion can
// still surface even if not in the last 15 fetched above.

async function getTaskKnowledgeContext({ userId, taskId, projectId, organizationId, query }) {
  const authorizedScope = await assertTaskAccess(userId, taskId);
  const facts = await getTaskFacts(authorizedScope.taskId);

  let semanticHits = [];
  try {
    semanticHits = await searchKnowledge({
      query,
      userId,
      organizationId: authorizedScope.organizationId,
      projectId: authorizedScope.projectId,
      taskId: authorizedScope.taskId,
      limit: 6,
    });
  } catch (error) {
    // Semantic search is a bonus signal, not a hard dependency -
    // if OpenRouter/embeddings are unavailable, fall back to facts only.
    console.error("Semantic search unavailable:", error.message);
  }

  return { facts, semanticHits };
}

// ============================================================
// PROJECT TASKS (for project-level AI chat)
async function getProjectTasks(projectId, userId) {
  const result = await pool.query(
    `
    SELECT
      t.id,
      t.title,
      t.description,
      t.status,
      t.priority,
      t.due_date,
      t.created_at,
      t.updated_at,
      assignee.name AS assignee_name,
      creator.name AS creator_name
    FROM tasks t
    LEFT JOIN users assignee
      ON assignee.id = t.assignee_id
    JOIN users creator
      ON creator.id = t.created_by
    WHERE t.project_id = $1
      AND EXISTS (
        SELECT 1 FROM organization_members om
        WHERE om.organization_id = (
          SELECT organization_id FROM projects WHERE id = t.project_id
        )
          AND om.user_id = $2
      )
      AND (
        EXISTS (
          SELECT 1 FROM organization_members om
          WHERE om.organization_id = (
            SELECT organization_id FROM projects WHERE id = t.project_id
          )
            AND om.user_id = $2 AND om.role = 'owner'
        )
        OR EXISTS (
          SELECT 1 FROM project_members pm
          WHERE pm.project_id = t.project_id
            AND pm.user_id = $2 AND pm.role = 'project_admin'
        )
        OR (
          t.assignee_id = $2
          AND EXISTS (
            SELECT 1 FROM project_members pm
            WHERE pm.project_id = t.project_id AND pm.user_id = $2
          )
        )
      )
    ORDER BY t.created_at DESC
    `,
    [projectId, userId]
  );

  return result.rows;
}
// ============================================================

async function getProjectStatus(projectId, key, client = pool) {
  const result = await client.query(
    `SELECT id, key FROM project_statuses WHERE project_id = $1 AND key = $2`,
    [projectId, key],
  );
  return result.rows[0] || null;
}

async function assertProjectManager(userId, projectId, client = pool) {
  const target = await client.query(
    "SELECT organization_id FROM projects WHERE id = $1 FOR SHARE",
    [projectId],
  );
  if (!target.rowCount) {
    const error = new Error("Project not found.");
    error.status = 404;
    throw error;
  }
  const organizationMembership = await client.query(
    `SELECT role FROM organization_members
     WHERE organization_id = $1 AND user_id = $2 FOR SHARE`,
    [target.rows[0].organization_id, userId],
  );
  const projectMembership = await client.query(
    `SELECT role FROM project_members
     WHERE project_id = $1 AND user_id = $2 FOR SHARE`,
    [projectId, userId],
  );
  if (!organizationMembership.rowCount
    || (organizationMembership.rows[0]?.role !== "owner"
    && projectMembership.rows[0]?.role !== "project_admin")) {
    const error = new Error("Project administrator permission required.");
    error.status = 403;
    throw error;
  }
}

async function assertProjectAssignee(projectId, assigneeId, client = pool) {
  if (assigneeId === null || assigneeId === undefined || assigneeId === "") return;
  const result = await client.query(
    `SELECT 1
     FROM project_members pm
     JOIN projects p ON p.id = pm.project_id
     JOIN organization_members om
       ON om.organization_id = p.organization_id AND om.user_id = pm.user_id
     WHERE pm.project_id = $1 AND pm.user_id = $2
     FOR SHARE OF pm, om`,
    [projectId, assigneeId],
  );
  if (!result.rowCount) {
    const error = new Error("Task assignee must be a member of this project.");
    error.status = 403;
    throw error;
  }
}

// ============================================================

// ============================================================
// CREATE TASK
// ============================================================
//
// Creates a new task inside the already-authorized project.
// projectId comes from assertTaskAccess(), not directly from
// the frontend request body.
//

async function createTask({
  projectId,
  title,
  description = "",
  status = "todo",
  priority = "medium",
  dueDate = null,
  assigneeId = null,
  createdBy,
  client = pool,
}) {
  await assertProjectManager(createdBy, projectId, client);
  const projectStatus = await getProjectStatus(projectId, status, client);
  if (!projectStatus) {
    const error = new Error("Invalid task status.");
    error.status = 400;
    throw error;
  }
  await assertProjectAssignee(projectId, assigneeId, client);

  const result = await client.query(
    `
    INSERT INTO tasks (
      project_id,
      title,
      description,
      status,
      status_id,
      priority,
      due_date,
      assignee_id,
      created_by
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING
      id,
      project_id,
      title,
      description,
      status,
      priority,
      due_date,
      assignee_id,
      created_by,
      status_id,
      created_at,
      updated_at
    `,
    [
      projectId,
      title,
      description,
      status,
      projectStatus.id,
      priority,
      dueDate,
      assigneeId,
      createdBy,
    ]
  );

  return {
    task: result.rows[0],
  };
}


// ============================================================
// UPDATE TASK FOR AI AGENT
// ============================================================
//
// Updates the current authorized task.
//
// Security:
// 1. taskId + projectId must match the real task.
// 2. userId must belong to the project's organization.
// 3. userId must be the organization owner or project admin.
// 4. Assignee must belong to the same organization.
// 5. Only fields supplied by the Agent are changed.
// ============================================================

async function updateTask({
  taskId,
  projectId,
  userId,
  title,
  description,
  status,
  priority,
  assigneeId,
  dueDate,
  client = pool,
}) {
  // ==========================================================
  // CHECK CURRENT TASK + PROJECT
  // ==========================================================

  const existing = await client.query(
    `
    SELECT
      t.*,
      p.organization_id
    FROM tasks t
    JOIN projects p
      ON p.id = t.project_id
    WHERE t.id = $1
      AND t.project_id = $2
    FOR UPDATE OF t, p
    `,
    [taskId, projectId]
  );

  if (!existing.rowCount) {
    const error = new Error("Task not found.");
    error.status = 404;
    throw error;
  }

  const task = existing.rows[0];

  const organizationId = task.organization_id;

  // ==========================================================
  // CHECK USER ORGANIZATION ADMIN PERMISSION
  // ==========================================================

  const organizationMembership = await client.query(
    `SELECT role FROM organization_members
     WHERE organization_id = $1 AND user_id = $2 FOR SHARE`,
    [organizationId, userId],
  );
  const projectMembership = await client.query(
    `SELECT role FROM project_members
     WHERE project_id = $1 AND user_id = $2 FOR SHARE`,
    [projectId, userId],
  );
  const access = {
    is_org_owner: organizationMembership.rows[0]?.role === "owner",
    is_project_admin: projectMembership.rows[0]?.role === "project_admin",
    is_project_member: Boolean(projectMembership.rowCount),
  };

  if (!organizationMembership.rowCount
    || (!access.is_org_owner && !access.is_project_member)) {
    const error = new Error(
      "You do not have access to this task."
    );

    error.status = 403;

    throw error;
  }

  if (!access.is_org_owner && !access.is_project_admin) {
    const error = new Error(
      "Project administrator permission required."
    );

    error.status = 403;

    throw error;
  }

  // ==========================================================
  // KEEP OLD VALUES IF NOT PROVIDED
  // ==========================================================

  const updatedTitle =
    title !== undefined
      ? String(title).trim()
      : task.title;

  const updatedDescription =
    description !== undefined
      ? String(description)
      : task.description;

  const updatedStatus =
    status !== undefined
      ? status
      : task.status;

  const updatedPriority =
    priority !== undefined
      ? priority
      : task.priority;

  const updatedAssigneeId =
    assigneeId !== undefined
      ? assigneeId
      : task.assignee_id;

  const updatedDueDate =
    dueDate !== undefined
      ? (
          dueDate &&
          String(dueDate).trim()
            ? String(dueDate).trim()
            : null
        )
      : task.due_date;

  // ==========================================================
  // VALIDATE TITLE
  // ==========================================================

  if (!updatedTitle) {
    const error = new Error(
      "Task title is required."
    );

    error.status = 400;

    throw error;
  }

  // ==========================================================
  // VALIDATE STATUS
  // ==========================================================

  const projectStatus = await getProjectStatus(projectId, updatedStatus, client);

  if (!projectStatus) {
    const error = new Error(
      "Invalid task status."
    );

    error.status = 400;

    throw error;
  }

  // ==========================================================
  // VALIDATE PRIORITY
  // ==========================================================

  const allowedPriorities = [
    "no_priority",
    "low",
    "medium",
    "high",
    "urgent",
  ];

  if (!allowedPriorities.includes(updatedPriority)) {
    const error = new Error(
      "Invalid task priority."
    );

    error.status = 400;

    throw error;
  }

  // ==========================================================
  // CHECK ASSIGNEE
  // ==========================================================

  await assertProjectAssignee(projectId, updatedAssigneeId, client);

  // ==========================================================
  // UPDATE DATABASE
  // ==========================================================

  const result = await client.query(
    `
    UPDATE tasks
    SET
      title = $1,
      description = $2,
      status = $3,
      status_id = $4,
      priority = $5,
      assignee_id = $6,
      due_date = $7,
      updated_at = NOW()
    WHERE id = $8
      AND project_id = $9
    RETURNING *
    `,
    [
      updatedTitle,
      updatedDescription,
      updatedStatus,
      projectStatus.id,
      updatedPriority,
      updatedAssigneeId,
      updatedDueDate,
      taskId,
      projectId,
    ]
  );

  if (!result.rowCount) {
    const error = new Error(
      "Task could not be updated."
    );

    error.status = 500;

    throw error;
  }

  return {
    task: result.rows[0],
    before: {
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      due_date: task.due_date,
      assignee_id: task.assignee_id,
    },
  };
}

// ============================================================
// DELETE TASK FOR AI AGENT
// ============================================================
//
// Deletes the current task only after authorization.
//
// Security:
// 1. Task must belong to the authorized project.
// 2. User must belong to the organization.
// 3. User must be the organization owner or project admin.
// ============================================================

async function deleteTask({
  taskId,
  projectId,
  userId,
  client: suppliedClient,
}) {
  const ownsTransaction = !suppliedClient;
  const client = suppliedClient || await pool.connect();

  try {
    if (ownsTransaction) await client.query("BEGIN");

    // ==========================================================
    // CHECK CURRENT TASK + PROJECT
    // ==========================================================

    const existing = await client.query(
      `
      SELECT
        t.*,
        p.organization_id
      FROM tasks t
      JOIN projects p
        ON p.id = t.project_id
      JOIN organizations o
        ON o.id = p.organization_id
      WHERE t.id = $1
        AND t.project_id = $2
      FOR UPDATE OF t, p, o
      `,
      [taskId, projectId]
    );

    if (!existing.rowCount) {
      const error = new Error("Task not found.");
      error.status = 404;
      throw error;
    }

    const task = existing.rows[0];

    const organizationId = task.organization_id;

    const organizationMemberships = await client.query(
      `SELECT user_id, role FROM organization_members
       WHERE organization_id = $1
       FOR SHARE`,
      [organizationId],
    );
    const projectMemberships = await client.query(
      `SELECT user_id, role FROM project_members
       WHERE project_id = $1
       FOR SHARE`,
      [projectId],
    );

    // ==========================================================
    // CHECK OWNER/PROJECT-ADMIN PERMISSION
    // ==========================================================

    const actorOrganizationMemberships = organizationMemberships.rows
      .filter((row) => String(row.user_id) === String(userId));
    const actorProjectMemberships = projectMemberships.rows
      .filter((row) => String(row.user_id) === String(userId));
    const access = {
      is_org_member: actorOrganizationMemberships.length > 0,
      is_org_owner: actorOrganizationMemberships.some((row) => row.role === "owner"),
      is_project_admin: actorProjectMemberships.some((row) => row.role === "project_admin"),
    };

    // ==========================================================
    // USER MUST BE ORGANIZATION MEMBER
    // ==========================================================

    if (!access.is_org_member) {
      const error = new Error(
        "You do not have access to this task."
      );

      error.status = 403;

      throw error;
    }

    // ==========================================================
    // USER MUST BE ORG OWNER OR PROJECT ADMIN
    // ==========================================================

    if (!access.is_org_owner && !access.is_project_admin) {
      const error = new Error(
        "Project administrator permission required."
      );

      error.status = 403;

      throw error;
    }

    const audienceUserIds = new Set();
    for (const membership of organizationMemberships.rows) {
      if (membership.role === "owner") audienceUserIds.add(Number(membership.user_id));
    }
    for (const membership of projectMemberships.rows) {
      if (membership.role === "project_admin") audienceUserIds.add(Number(membership.user_id));
      if (
        task.assignee_id !== null
        && String(membership.user_id) === String(task.assignee_id)
      ) {
        audienceUserIds.add(Number(membership.user_id));
      }
    }

    // ==========================================================
    // DELETE TASK
    // ==========================================================

    const result = await client.query(
      `
      DELETE FROM tasks
      WHERE id = $1
        AND project_id = $2
      RETURNING *
      `,
      [taskId, projectId]
    );

    if (!result.rowCount) {
      const error = new Error(
        "Task could not be deleted."
      );

      error.status = 500;

      throw error;
    }

    if (ownsTransaction) await client.query("COMMIT");

    return {
      task: result.rows[0],
      audienceUserIds: [...audienceUserIds],
    };
  } catch (error) {
    if (ownsTransaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

module.exports = {
  assertTaskAccess,
  getTaskFacts,
  getProjectFacts,
  getProjectTasks,
  getTaskKnowledgeContext,
  createTask,
  getUserOrganizationIds,
  getGlobalFacts,
  keywordSearchTasks,
  getGlobalKnowledgeContext,
  updateTask,
  deleteTask,
  assertProjectManager,
};

// ============================================================
// GLOBAL AI (search/answer across everything the user can see)
// ============================================================

// Every organization this user is a member of - the hard boundary
// for anything the global assistant is allowed to touch.
async function getUserOrganizationIds(userId) {
  const result = await pool.query(
    `SELECT organization_id FROM organization_members WHERE user_id = $1`,
    [userId]
  );
  return result.rows.map((r) => r.organization_id);
}

// Structured, always-accurate counts + lists (spec section 10/63).
async function getGlobalFacts(userId) {
  const tasksResult = await pool.query(
    `
    SELECT
      t.id, t.title, t.status, t.priority, t.due_date, t.updated_at,
      t.assignee_id, t.project_id,
      p.name AS project_name,
      o.id AS organization_id, o.name AS organization_name
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN organizations o ON o.id = p.organization_id
    WHERE EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.organization_id = p.organization_id AND om.user_id = $1
    )
    AND (
      EXISTS (
        SELECT 1 FROM organization_members om
        WHERE om.organization_id = p.organization_id
          AND om.user_id = $1 AND om.role = 'owner'
      )
      OR EXISTS (
        SELECT 1 FROM project_members pm
        WHERE pm.project_id = p.id AND pm.user_id = $1
          AND pm.role = 'project_admin'
      )
      OR EXISTS (
        SELECT 1 FROM project_members pm
        WHERE pm.project_id = p.id AND pm.user_id = $1
          AND t.assignee_id = $1
      )
    )
    ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC
    `,
    [userId]
  );

  const allTasks = tasksResult.rows;
  const myTasks = allTasks.filter((t) => Number(t.assignee_id) === Number(userId));

  const now = new Date();
  const isOverdue = (t) =>
    t.due_date && t.status !== "done" && t.status !== "cancelled" && new Date(t.due_date) < now;
  const isDoneToday = (t) => {
    if (t.status !== "done" || !t.updated_at) return false;
    const u = new Date(t.updated_at);
    return u.toDateString() === now.toDateString();
  };

  return {
    myTasksTotal: myTasks.length,
    myPending: myTasks.filter((t) => t.status !== "done" && t.status !== "cancelled").length,
    myOverdue: myTasks.filter(isOverdue),
    myCompletedToday: myTasks.filter(isDoneToday),
    myTasks,
  };
}

// Cheap keyword/full-text style search (ILIKE), scoped to the user's
// own organizations - this is the "keyword" half of hybrid search,
// good for "find the task where users get a 401" type lookups.
async function keywordSearchTasks(userId, query, limit = 8) {
  const result = await pool.query(
    `
    SELECT
      t.id, t.title, t.status, t.priority,
      p.name AS project_name, o.name AS organization_name
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN organizations o ON o.id = p.organization_id
    WHERE EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.organization_id = p.organization_id AND om.user_id = $1
    )
    AND (
      EXISTS (
        SELECT 1 FROM organization_members om
        WHERE om.organization_id = p.organization_id
          AND om.user_id = $1 AND om.role = 'owner'
      )
      OR EXISTS (
        SELECT 1 FROM project_members pm
        WHERE pm.project_id = p.id AND pm.user_id = $1
          AND pm.role = 'project_admin'
      )
      OR EXISTS (
        SELECT 1 FROM project_members pm
        WHERE pm.project_id = p.id AND pm.user_id = $1
          AND t.assignee_id = $1
      )
    )
    AND (t.title ILIKE $2 OR t.description ILIKE $2)
    ORDER BY t.created_at DESC
    LIMIT $3
    `,
    [userId, `%${query}%`, limit]
  );

  return result.rows;
}

// Hybrid retrieval for the global assistant: facts + keyword + semantic,
// all scoped to organizations this user actually belongs to.
async function getGlobalKnowledgeContext(userId, query) {
  const organizationIds = await getUserOrganizationIds(userId);
  const facts = await getGlobalFacts(userId);

  let semanticHits = [];
  let keywordHits = [];

  try {
    [semanticHits, keywordHits] = await Promise.all([
      searchKnowledgeAcrossOrganizations({ query, organizationIds, userId, limit: 6 }),
      keywordSearchTasks(userId, query, 5),
    ]);
  } catch (error) {
    console.error("Global search unavailable:", error.message);
  }

  return { facts, semanticHits, keywordHits, organizationIds };
}
