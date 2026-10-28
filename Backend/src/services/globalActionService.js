const crypto = require("node:crypto");
const pool = require("../config/database");
const { requireOrganizationAdminOrOwner } = require("../middleware/authorizationMiddleware");
const { assertProjectManager } = require("./retrievalService");

const PROPOSAL_TTL_MINUTES = 20;

function safeFailure(error) {
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    return error.message;
  }
  return "The action could not be completed. No changes were applied.";
}

function serializeProposal(row) {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    operation: row.operation,
    arguments: row.arguments,
    context: row.context_type ? { entityType: row.context_type, entityId: row.context_id } : null,
    target: row.target,
    changes: row.changes,
    summary: row.summary,
    status: row.status.toLowerCase(),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    cancelledAt: row.cancelled_at,
    executingAt: row.executing_at,
    completedAt: row.completed_at,
    result: row.result,
    error: row.error_summary,
  };
}

function proposalSummary(operation, args, target) {
  switch (operation) {
    case "create_organization":
      return `Create organization "${args.name.trim()}".`;
    case "create_project":
      return `Create project "${args.name.trim()}" in ${target.organizationName}.`;
    case "create_task":
      return `Create task "${args.title.trim()}" in ${target.projectName}.`;
    case "update_current_task":
      return `Update task "${target.taskName}" in ${target.projectName}.`;
    default:
      throw new Error("This AI action is not supported.");
  }
}

async function resolveTarget(client, operation, args, userId, scope) {
  const target = {
    organizationId: scope.organizationId || null,
    projectId: scope.projectId || null,
    taskId: scope.taskId || null,
    organizationName: null,
    projectName: null,
    taskName: null,
  };

  if (operation === "create_organization") return target;

  const organization = await client.query(
    `SELECT id, name FROM organizations WHERE id = $1
     AND EXISTS (SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2)`,
    [scope.organizationId, userId],
  );
  if (!organization.rowCount) {
    const error = new Error("The target organization is no longer available to you.");
    error.status = 403;
    throw error;
  }
  target.organizationName = organization.rows[0].name;

  if (["create_task", "update_current_task"].includes(operation)) {
    const project = await client.query(
      `SELECT p.id, p.name FROM projects p
       WHERE p.id = $1 AND p.organization_id = $2
         AND (EXISTS (SELECT 1 FROM organization_members om
                      WHERE om.organization_id = p.organization_id AND om.user_id = $3 AND om.role = 'owner')
           OR EXISTS (SELECT 1 FROM project_members pm
                      WHERE pm.project_id = p.id AND pm.user_id = $3))`,
      [scope.projectId, scope.organizationId, userId],
    );
    if (!project.rowCount) {
      const error = new Error("The target project is no longer available to you.");
      error.status = 403;
      throw error;
    }
    target.projectName = project.rows[0].name;
  }

  if (operation === "update_current_task") {
    const task = await client.query(
      `SELECT id, title, status, priority, due_date, assignee_id
       FROM tasks WHERE id = $1 AND project_id = $2`,
      [scope.taskId, scope.projectId],
    );
    if (!task.rowCount) {
      const error = new Error("The target task no longer exists in this project.");
      error.status = 404;
      throw error;
    }
    target.taskName = task.rows[0].title;
    target.before = task.rows[0];
  }

  if (operation === "create_project") {
    await requireOrganizationAdminOrOwner(userId, scope.organizationId, client);
  }
  if (["create_task", "update_current_task"].includes(operation)) {
    await assertProjectManager(userId, scope.projectId, client);
  }

  return target;
}

async function createProposal({ userId, sessionId, requestId, operation, args, context, scope }) {
  const aiService = require("./aiService");
  aiService.validateGlobalToolArguments(operation, args);
  const id = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await resolveTarget(client, operation, args, userId, scope);
    const changes = operation === "update_current_task"
      ? { before: target.before, after: { ...args } }
      : { after: { ...args } };
    const summary = proposalSummary(operation, args, target);
    const inserted = await client.query(
      `INSERT INTO global_ai_action_proposals
         (id, idempotency_key, request_id, user_id, session_id, operation, arguments,
          context_type, context_id, organization_id, project_id, task_id,
          summary, target, changes, expires_at)
       VALUES ($1, $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11,
               $12, $13::jsonb, $14::jsonb, NOW() + ($15 * INTERVAL '1 minute'))
       ON CONFLICT (user_id, request_id) WHERE request_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        id,
        requestId || null,
        userId,
        sessionId,
        operation,
        JSON.stringify(args),
        context?.entityType || null,
        context?.entityId || null,
        scope.organizationId || null,
        scope.projectId || null,
        scope.taskId || null,
        summary,
        JSON.stringify(target),
        JSON.stringify(changes),
        PROPOSAL_TTL_MINUTES,
      ],
    );
    if (!inserted.rowCount && requestId) {
      const existing = await client.query(
        `SELECT * FROM global_ai_action_proposals
         WHERE user_id = $1 AND request_id = $2
           AND operation = $3 AND arguments = $4::jsonb
           AND context_type IS NOT DISTINCT FROM $5
           AND context_id IS NOT DISTINCT FROM $6
           AND organization_id IS NOT DISTINCT FROM $7
           AND project_id IS NOT DISTINCT FROM $8
           AND task_id IS NOT DISTINCT FROM $9`,
        [
          userId,
          requestId,
          operation,
          JSON.stringify(args),
          context?.entityType || null,
          context?.entityId || null,
          scope.organizationId || null,
          scope.projectId || null,
          scope.taskId || null,
        ],
      );
      if (!existing.rowCount) {
        const error = new Error("This request ID was already used for a different AI action.");
        error.status = 409;
        throw error;
      }
      await client.query("COMMIT");
      return serializeProposal(existing.rows[0]);
    }
    await client.query("COMMIT");
    return serializeProposal(inserted.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function listProposals(userId, sessionId = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE global_ai_action_proposals
       SET status = 'EXPIRED', completed_at = NOW()
       WHERE user_id = $1 AND status IN ('PROPOSED', 'APPROVED') AND expires_at <= NOW()`,
      [userId],
    );
    const result = await client.query(
      `SELECT * FROM global_ai_action_proposals
       WHERE user_id = $1
         AND (($2::bigint IS NOT NULL AND session_id = $2)
           OR status IN ('PROPOSED', 'APPROVED', 'EXECUTING'))
       ORDER BY created_at DESC LIMIT 50`,
      [userId, sessionId],
    );
    await client.query("COMMIT");
    return result.rows.map(serializeProposal);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function cancelProposal(userId, proposalId) {
  const result = await pool.query(
    `UPDATE global_ai_action_proposals
     SET status = 'CANCELLED', cancelled_at = NOW(), completed_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status IN ('PROPOSED', 'APPROVED')
       AND expires_at > NOW()
     RETURNING *`,
    [proposalId, userId],
  );
  if (result.rowCount) return serializeProposal(result.rows[0]);
  const current = await pool.query(
    "SELECT * FROM global_ai_action_proposals WHERE id = $1 AND user_id = $2",
    [proposalId, userId],
  );
  if (!current.rowCount) {
    const error = new Error("Action proposal not found.");
    error.status = 404;
    throw error;
  }
  const row = current.rows[0];
  if (["PROPOSED", "APPROVED"].includes(row.status) && new Date(row.expires_at) <= new Date()) {
    const expired = await pool.query(
      `UPDATE global_ai_action_proposals SET status = 'EXPIRED', completed_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status IN ('PROPOSED', 'APPROVED') RETURNING *`,
      [proposalId, userId],
    );
    return serializeProposal(expired.rows[0]);
  }
  const error = new Error(`This proposal cannot be cancelled because it is ${row.status.toLowerCase()}.`);
  error.status = 409;
  error.proposal = serializeProposal(row);
  throw error;
}

async function assertCurrentAuthorization(client, userId, row) {
  const aiService = require("./aiService");
  const expectedContext = row.context_type
    ? { entityType: row.context_type, entityId: row.context_id }
    : null;
  const currentScope = await aiService.getPageMemoryScope(userId, expectedContext, client);
  for (const key of ["organizationId", "projectId", "taskId"]) {
    const saved = row[`${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`];
    if (saved != null && String(currentScope[key]) !== String(saved)) {
      const error = new Error("The proposal target has changed. Please request a new action.");
      error.status = 409;
      throw error;
    }
  }

  if (row.operation === "create_project") {
    await requireOrganizationAdminOrOwner(userId, row.organization_id, client);
  } else if (["create_task", "update_current_task"].includes(row.operation)) {
    const target = await client.query(
      `SELECT p.organization_id FROM projects p
       WHERE p.id = $1 AND p.organization_id = $2 FOR SHARE`,
      [row.project_id, row.organization_id],
    );
    if (!target.rowCount) {
      const error = new Error("The proposal's project no longer exists in the expected organization.");
      error.status = 409;
      throw error;
    }
    const memberships = await client.query(
      `SELECT om.role AS organization_role, pm.role AS project_role
       FROM organization_members om
       LEFT JOIN project_members pm ON pm.project_id = $2 AND pm.user_id = om.user_id
       WHERE om.organization_id = $1 AND om.user_id = $3
       FOR SHARE OF om`,
      [row.organization_id, row.project_id, userId],
    );
    const access = memberships.rows[0];
    if (!access) {
      const error = new Error("Your organization access was revoked.");
      error.status = 403;
      throw error;
    }
    await client.query(
      "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2 FOR SHARE",
      [row.project_id, userId],
    );
    if (row.operation === "create_task"
      && access.organization_role !== "owner" && access.project_role !== "project_admin") {
      const error = new Error("Project administrator permission is required to create a task.");
      error.status = 403;
      throw error;
    }
    if (row.operation === "update_current_task"
      && access.organization_role !== "owner" && access.project_role !== "project_admin") {
      const error = new Error("Project administrator permission is required to update this task.");
      error.status = 403;
      throw error;
    }
  }
  return currentScope;
}

async function executeApprovedProposal(client, userId, row) {
  const aiService = require("./aiService");
  const scope = await assertCurrentAuthorization(client, userId, row);
  return aiService.executeGlobalTool(row.operation, row.arguments, userId, scope, client);
}

async function approveProposal(userId, proposalId) {
  const approveClient = await pool.connect();
  try {
    await approveClient.query("BEGIN");
    const selected = await approveClient.query(
      `SELECT * FROM global_ai_action_proposals
       WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [proposalId, userId],
    );
    if (!selected.rowCount) {
      const error = new Error("Action proposal not found.");
      error.status = 404;
      throw error;
    }
    let row = selected.rows[0];
    if (row.status === "SUCCEEDED") {
      await approveClient.query("COMMIT");
      return { proposal: serializeProposal(row), result: row.result, replayed: true };
    }
    if (row.status === "FAILED") {
      await approveClient.query("COMMIT");
      return { proposal: serializeProposal(row), result: null, replayed: true };
    }
    if (!["PROPOSED", "APPROVED"].includes(row.status)) {
      const error = new Error(`This proposal cannot be approved because it is ${row.status.toLowerCase()}.`);
      error.status = 409;
      error.proposal = serializeProposal(row);
      throw error;
    }
    if (new Date(row.expires_at) <= new Date()) {
      row = (await approveClient.query(
        `UPDATE global_ai_action_proposals SET status = 'EXPIRED', completed_at = NOW()
         WHERE id = $1 RETURNING *`,
        [proposalId],
      )).rows[0];
      await approveClient.query("COMMIT");
      const error = new Error("This action proposal has expired.");
      error.status = 409;
      error.proposal = serializeProposal(row);
      throw error;
    }
    await assertCurrentAuthorization(approveClient, userId, row);
    if (row.status === "PROPOSED") {
      row = (await approveClient.query(
        `UPDATE global_ai_action_proposals
         SET status = 'APPROVED', approved_at = NOW()
         WHERE id = $1 RETURNING *`,
        [proposalId],
      )).rows[0];
    }
    await approveClient.query("COMMIT");
  } catch (error) {
    await approveClient.query("ROLLBACK").catch(() => {});
    approveClient.release();
    throw error;
  }
  approveClient.release();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT * FROM global_ai_action_proposals
       WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [proposalId, userId],
    );
    if (!selected.rowCount) {
      const error = new Error("Action proposal not found.");
      error.status = 404;
      throw error;
    }
    let row = selected.rows[0];
    if (row.status === "SUCCEEDED") {
      await client.query("COMMIT");
      return { proposal: serializeProposal(row), result: row.result, replayed: true };
    }
    if (row.status === "FAILED") {
      await client.query("COMMIT");
      return { proposal: serializeProposal(row), result: null, replayed: true };
    }
    if (row.status !== "APPROVED") {
      const error = new Error(`This proposal cannot execute because it is ${row.status.toLowerCase()}.`);
      error.status = 409;
      error.proposal = serializeProposal(row);
      throw error;
    }
    if (new Date(row.expires_at) <= new Date()) {
      const expired = await client.query(
        `UPDATE global_ai_action_proposals SET status = 'EXPIRED', completed_at = NOW()
         WHERE id = $1 RETURNING *`,
        [proposalId],
      );
      await client.query("COMMIT");
      return { proposal: serializeProposal(expired.rows[0]), result: null, replayed: false };
    }
    row = (await client.query(
      `UPDATE global_ai_action_proposals
       SET status = 'EXECUTING', executing_at = NOW()
       WHERE id = $1 RETURNING *`,
      [proposalId],
    )).rows[0];
    await client.query("SAVEPOINT global_ai_action");
    try {
      const result = await executeApprovedProposal(client, userId, row);
      await client.query(
        `UPDATE global_ai_action_proposals
         SET status = 'SUCCEEDED', result = $2::jsonb, completed_at = NOW(), error_summary = NULL
         WHERE id = $1`,
        [proposalId, JSON.stringify(result)],
      );
      await client.query("COMMIT");
      const completed = await pool.query(
        "SELECT * FROM global_ai_action_proposals WHERE id = $1 AND user_id = $2",
        [proposalId, userId],
      );
      return {
        proposal: serializeProposal(completed.rows[0]),
        result,
        replayed: false,
      };
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT global_ai_action");
      const failure = safeFailure(error);
      const failed = await client.query(
        `UPDATE global_ai_action_proposals
         SET status = 'FAILED', error_summary = $2, completed_at = NOW()
         WHERE id = $1 RETURNING *`,
        [proposalId, failure],
      );
      await client.query("COMMIT");
      return {
        proposal: serializeProposal(failed.rows[0]),
        result: null,
        replayed: false,
      };
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    try {
      const persisted = await pool.query(
        "SELECT * FROM global_ai_action_proposals WHERE id = $1 AND user_id = $2",
        [proposalId, userId],
      );
      const row = persisted.rows[0];
      if (row?.status === "SUCCEEDED") {
        return { proposal: serializeProposal(row), result: row.result, replayed: true };
      }
      if (row?.status === "FAILED") {
        return { proposal: serializeProposal(row), result: null, replayed: true };
      }
      if (row?.status === "APPROVED" || row?.status === "EXECUTING") {
        const uncertain = new Error("The action outcome could not be confirmed. Retry this same proposal to check its stored result.");
        uncertain.status = 503;
        uncertain.outcomeUnknown = true;
        throw uncertain;
      }
    } catch (lookupError) {
      if (lookupError.outcomeUnknown) throw lookupError;
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  createProposal,
  listProposals,
  cancelProposal,
  approveProposal,
  serializeProposal,
};
