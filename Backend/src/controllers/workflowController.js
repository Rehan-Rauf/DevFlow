const pool = require("../config/database");
const { ok, created, fail } = require("../utils/response");

const DEFAULT_STATUSES = [
  ["backlog", "Backlog", "#7d8797", 0],
  ["todo", "To do", "#6fa8ff", 1],
  ["in_progress", "In progress", "#d7b66f", 2],
  ["in_review", "In review", "#c58bff", 3],
  ["done", "Done", "#59d68c", 4],
  ["cancelled", "Cancelled", "#ef8e99", 5],
];

const DEFAULT_ROLE_TAGS = [
  ["UX Designer", "User goal:\n\nUser flow:\n\nAcceptance criteria:\n"],
  ["UI Designer", "Design scope:\n\nScreens/components:\n\nVisual acceptance criteria:\n"],
  ["Frontend Dev", "Implementation scope:\n\nComponents and states:\n\nAcceptance criteria:\n\nTesting notes:\n"],
  ["Backend Dev", "API/data scope:\n\nImplementation notes:\n\nAcceptance criteria:\n\nTest coverage:\n"],
  ["QA Tester", "Test objective:\n\nTest scenarios:\n\nExpected results:\n\nRegression coverage:\n"],
];

function isValidColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || ""));
}

function statusKey(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

async function projectAccess(userId, projectId) {
  const result = await pool.query(
    `SELECT p.id, p.organization_id,
      EXISTS (SELECT 1 FROM organization_members om WHERE om.organization_id = p.organization_id AND om.user_id = $1 AND om.role = 'owner') AS is_org_owner,
      EXISTS (SELECT 1 FROM organization_members om WHERE om.organization_id = p.organization_id AND om.user_id = $1 AND om.role IN ('owner', 'admin')) AS is_org_admin,
      EXISTS (SELECT 1 FROM organization_members om WHERE om.organization_id = p.organization_id AND om.user_id = $1) AS is_org_member,
      EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1
        AND EXISTS (SELECT 1 FROM organization_members om WHERE om.organization_id = p.organization_id AND om.user_id = pm.user_id)) AS is_member,
      EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1 AND pm.role = 'project_admin'
        AND EXISTS (SELECT 1 FROM organization_members om WHERE om.organization_id = p.organization_id AND om.user_id = pm.user_id)) AS is_project_admin
     FROM projects p WHERE p.id = $2`,
    [userId, projectId],
  );
  return result.rows[0] || null;
}

async function requireProjectAdmin(userId, projectId) {
  const access = await projectAccess(userId, projectId);
  if (!access) {
    const error = new Error("Project not found.");
    error.status = 404;
    throw error;
  }
  if (!access.is_org_member || (!access.is_org_owner && !access.is_project_admin)) {
    const error = new Error("Project administrator permission required.");
    error.status = 403;
    throw error;
  }
  return access;
}

async function seedProjectWorkflow(client, projectId) {
  for (const [key, label, color, position] of DEFAULT_STATUSES) {
    await client.query(
      `INSERT INTO project_statuses (project_id, key, label, color, position)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (project_id, key) DO NOTHING`,
      [projectId, key, label, color, position],
    );
  }
  for (const [label, template] of DEFAULT_ROLE_TAGS) {
    await client.query(
      `INSERT INTO task_role_tags (project_id, label, description_template)
       VALUES ($1, $2, $3) ON CONFLICT (project_id, label) DO NOTHING`,
      [projectId, label, template],
    );
  }
}

async function listStatuses(req, res) {
  try {
    const access = await projectAccess(req.user.id, req.params.id);
    if (!access) return fail(res, 404, "Project not found.");
    if (!access.is_org_member || (!access.is_org_owner && !access.is_member)) return fail(res, 403, "Project access required.");
    const result = await pool.query(
      `SELECT id, project_id, key, label, color, position, created_at, updated_at
       FROM project_statuses WHERE project_id = $1 ORDER BY position, id`,
      [req.params.id],
    );
    return ok(res, result.rows);
  } catch (error) {
    console.error("List project statuses error:", error);
    return fail(res, 500, "Unable to load project statuses.");
  }
}

async function createStatus(req, res) {
  try {
    const projectId = Number(req.params.id);
    await requireProjectAdmin(req.user.id, projectId);
    const label = String(req.body.label || "").trim();
    const color = String(req.body.color || "#6d5dfc").trim();
    if (!label || label.length > 80 || !isValidColor(color)) {
      return fail(res, 400, "A status label and six-digit hex color are required.");
    }
    const baseKey = statusKey(label);
    if (!baseKey) return fail(res, 400, "Status label must contain letters or numbers.");
    const count = await pool.query(`SELECT COUNT(*)::int AS count FROM project_statuses WHERE project_id = $1`, [projectId]);
    let key = baseKey;
    let suffix = 2;
    while ((await pool.query(`SELECT 1 FROM project_statuses WHERE project_id = $1 AND key = $2`, [projectId, key])).rowCount) {
      key = `${baseKey.slice(0, 54)}_${suffix++}`;
    }
    const result = await pool.query(
      `INSERT INTO project_statuses (project_id, key, label, color, position)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [projectId, key, label, color, count.rows[0].count],
    );
    return created(res, result.rows[0], "Status created.");
  } catch (error) {
    console.error("Create project status error:", error);
    return fail(res, error.status || 500, error.status ? error.message : "Unable to create status.");
  }
}

async function updateStatus(req, res) {
  try {
    const projectId = Number(req.params.id);
    await requireProjectAdmin(req.user.id, projectId);
    const label = String(req.body.label || "").trim();
    const color = String(req.body.color || "").trim();
    if (!label || label.length > 80 || !isValidColor(color)) return fail(res, 400, "A status label and six-digit hex color are required.");
    const result = await pool.query(
      `UPDATE project_statuses SET label = $1, color = $2 WHERE id = $3 AND project_id = $4 RETURNING *`,
      [label, color, req.params.statusId, projectId],
    );
    if (!result.rowCount) return fail(res, 404, "Status not found.");
    return ok(res, result.rows[0], "Status updated.");
  } catch (error) {
    console.error("Update project status error:", error);
    return fail(res, error.status || 500, error.status ? error.message : "Unable to update status.");
  }
}

async function deleteStatus(req, res) {
  try {
    const projectId = Number(req.params.id);
    await requireProjectAdmin(req.user.id, projectId);
    const usage = await pool.query(`SELECT COUNT(*)::int AS count FROM tasks WHERE project_id = $1 AND status_id = $2`, [projectId, req.params.statusId]);
    if (usage.rows[0].count) return fail(res, 409, "Tasks use this status. Reassign them first.");
    const result = await pool.query(`DELETE FROM project_statuses WHERE id = $1 AND project_id = $2 RETURNING id`, [req.params.statusId, projectId]);
    if (!result.rowCount) return fail(res, 404, "Status not found.");
    return ok(res, null, "Status deleted.");
  } catch (error) {
    console.error("Delete project status error:", error);
    return fail(res, error.status || 500, error.status ? error.message : "Unable to delete status.");
  }
}

async function reorderStatuses(req, res) {
  const client = await pool.connect();
  try {
    const projectId = Number(req.params.id);
    await requireProjectAdmin(req.user.id, projectId);
    const statusIds = Array.isArray(req.body.statusIds) ? req.body.statusIds.map(Number) : [];
    const current = await client.query(`SELECT id FROM project_statuses WHERE project_id = $1 ORDER BY position`, [projectId]);
    if (statusIds.length !== current.rowCount || new Set(statusIds).size !== statusIds.length || !statusIds.every((id) => current.rows.some((status) => Number(status.id) === id))) {
      return fail(res, 400, "Send every project status exactly once.");
    }
    await client.query("BEGIN");
    await client.query(`UPDATE project_statuses SET position = -position - 1 WHERE project_id = $1`, [projectId]);
    for (let position = 0; position < statusIds.length; position += 1) {
      await client.query(`UPDATE project_statuses SET position = $1 WHERE project_id = $2 AND id = $3`, [position, projectId, statusIds[position]]);
    }
    await client.query("COMMIT");
    const result = await client.query(`SELECT * FROM project_statuses WHERE project_id = $1 ORDER BY position`, [projectId]);
    return ok(res, result.rows, "Statuses reordered.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Reorder project statuses error:", error);
    return fail(res, error.status || 500, error.status ? error.message : "Unable to reorder statuses.");
  } finally {
    client.release();
  }
}

async function listRoleTags(req, res) {
  try {
    const access = await projectAccess(req.user.id, req.params.id);
    if (!access) return fail(res, 404, "Project not found.");
    if (!access.is_org_member || !access.is_member) return fail(res, 403, "Project access required.");
    const result = await pool.query(`SELECT * FROM task_role_tags WHERE project_id = $1 ORDER BY label`, [req.params.id]);
    return ok(res, result.rows);
  } catch (error) {
    console.error("List role tags error:", error);
    return fail(res, 500, "Unable to load role tags.");
  }
}

async function createRoleTag(req, res) {
  try {
    const projectId = Number(req.params.id);
    await requireProjectAdmin(req.user.id, projectId);
    const label = String(req.body.label || "").trim();
    const descriptionTemplate = String(req.body.descriptionTemplate || "");
    if (!label || label.length > 100) return fail(res, 400, "A role label is required.");
    const result = await pool.query(`INSERT INTO task_role_tags (project_id, label, description_template) VALUES ($1, $2, $3) RETURNING *`, [projectId, label, descriptionTemplate]);
    return created(res, result.rows[0], "Role tag created.");
  } catch (error) {
    console.error("Create role tag error:", error);
    return fail(res, error.code === "23505" ? 409 : (error.status || 500), error.code === "23505" ? "A role tag with this label already exists." : (error.status ? error.message : "Unable to create role tag."));
  }
}

async function updateRoleTag(req, res) {
  try {
    const projectId = Number(req.params.id);
    await requireProjectAdmin(req.user.id, projectId);
    const label = String(req.body.label || "").trim();
    const descriptionTemplate = String(req.body.descriptionTemplate || "");
    if (!label || label.length > 100) return fail(res, 400, "A role label is required.");
    const result = await pool.query(`UPDATE task_role_tags SET label = $1, description_template = $2 WHERE id = $3 AND project_id = $4 RETURNING *`, [label, descriptionTemplate, req.params.roleTagId, projectId]);
    if (!result.rowCount) return fail(res, 404, "Role tag not found.");
    return ok(res, result.rows[0], "Role tag updated.");
  } catch (error) {
    console.error("Update role tag error:", error);
    return fail(res, error.code === "23505" ? 409 : (error.status || 500), error.code === "23505" ? "A role tag with this label already exists." : (error.status ? error.message : "Unable to update role tag."));
  }
}

async function deleteRoleTag(req, res) {
  try {
    const projectId = Number(req.params.id);
    await requireProjectAdmin(req.user.id, projectId);
    const usage = await pool.query(`SELECT COUNT(*)::int AS count FROM tasks WHERE project_id = $1 AND role_tag_id = $2`, [projectId, req.params.roleTagId]);
    if (usage.rows[0].count) return fail(res, 409, "Tasks use this role tag. Remove or change those task tags first.");
    const result = await pool.query(`DELETE FROM task_role_tags WHERE id = $1 AND project_id = $2 RETURNING id`, [req.params.roleTagId, projectId]);
    if (!result.rowCount) return fail(res, 404, "Role tag not found.");
    return ok(res, null, "Role tag deleted.");
  } catch (error) {
    console.error("Delete role tag error:", error);
    return fail(res, error.status || 500, error.status ? error.message : "Unable to delete role tag.");
  }
}

module.exports = {
  DEFAULT_STATUSES,
  DEFAULT_ROLE_TAGS,
  seedProjectWorkflow,
  listStatuses,
  createStatus,
  updateStatus,
  deleteStatus,
  reorderStatuses,
  listRoleTags,
  createRoleTag,
  updateRoleTag,
  deleteRoleTag,
};
