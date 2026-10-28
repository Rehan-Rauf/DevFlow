// // Import PostgreSQL database connection/pool
const pool = require("../config/database");
const { isPositiveIntegerId } = require("../utils/validation");

// Import response helper functions
// ok = successful response
// created = resource successfully created
// fail = error response
const { ok, created, fail } = require("../utils/response");
const knowledgeBaseService = require("../services/knowledgeBaseService");
const { seedProjectWorkflow } = require("./workflowController");
const {
  requireOrganizationMember,
  requireOrganizationAdminOrOwner,
} = require("../middleware/authorizationMiddleware");

function reindexProjectInBackground(projectId) {
  knowledgeBaseService
    .indexProject(projectId)
    .catch((error) => console.error(`Knowledge reindex failed for project ${projectId}:`, error.message));
}

// ============================================================
// REQUIRE ORGANIZATION ADMIN
// ============================================================

// This function checks whether a user is an ADMIN
// of a particular organization.
async function requireOrgAdmin(userId, orgId) {
  return requireOrganizationAdminOrOwner(userId, orgId);
}

// ============================================================
// REQUIRE ORGANIZATION MEMBER
// ============================================================

// This function checks whether a user
// is a member of an organization.
async function requireOrgMember(userId, orgId) {
  return requireOrganizationMember(userId, orgId);
}

// ============================================================
// LIST PROJECTS
// ============================================================

// This function gets all projects
// belonging to a particular organization.
// ============================================================
// LIST PROJECTS
// ============================================================

// Get projects that the logged-in user is allowed to see.
//
// If organizationId is provided:
//
// GET /api/projects?organizationId=5
//
// → Get projects from organization 5.
//
// If organizationId is NOT provided:
//
// GET /api/projects
//
// → Get projects from ALL organizations
//   where the logged-in user is a member.

async function listProjects(req, res) {
  try {
    // Get optional organizationId from URL.
    const { organizationId } = req.query;

    // ========================================================
    // CASE 1:
    // ORGANIZATION ID WAS PROVIDED
    // ========================================================

    if (organizationId) {
      // First check that the logged-in user
      // belongs to this organization.
      await requireOrgMember(req.user.id, organizationId);

      // Organization owners have access to every project in the org. Regular
      // organization admins only see projects they are explicitly assigned to.
      const result = await pool.query(
        `
        SELECT
          p.*,

          COUNT(
            DISTINCT pm.user_id
          )::int AS member_count,

          o.name AS organization_name,

          om.role AS my_org_role,

          viewer_project.role AS my_project_role

        FROM projects p

        INNER JOIN organizations o
          ON o.id = p.organization_id

        INNER JOIN organization_members om
          ON om.organization_id = p.organization_id
         AND om.user_id = $2

        LEFT JOIN project_members viewer_project
          ON viewer_project.project_id = p.id
         AND viewer_project.user_id = $2

        LEFT JOIN project_members pm
          ON pm.project_id = p.id

        WHERE p.organization_id = $1
          AND (
            om.role = 'owner'
            OR viewer_project.user_id IS NOT NULL
          )

        GROUP BY
          p.id,
          o.name,
          om.role,
          viewer_project.role

        ORDER BY p.created_at DESC
        `,
        [organizationId, req.user.id],
      );

      // Return organization projects.
      return ok(res, result.rows);
    }

    // ========================================================
    // CASE 2:
    // NO ORGANIZATION ID
    // ========================================================

    // This is the new part.
    //
    // We find ALL projects belonging to organizations
    // where the logged-in user is a member.

    const result = await pool.query(
      `
      SELECT
        p.*,

        COUNT(
          DISTINCT pm.user_id
        )::int AS member_count,

        o.name AS organization_name,

        om.role AS my_org_role,

        viewer_project.role AS my_project_role

      FROM projects p

      INNER JOIN organizations o
        ON o.id = p.organization_id

      INNER JOIN organization_members om
        ON om.organization_id = p.organization_id
       AND om.user_id = $1

      LEFT JOIN project_members viewer_project
        ON viewer_project.project_id = p.id
       AND viewer_project.user_id = $1

      LEFT JOIN project_members pm
        ON pm.project_id = p.id

      WHERE om.role = 'owner'
         OR viewer_project.user_id IS NOT NULL

      GROUP BY
        p.id,
        o.name,
        om.role,
        viewer_project.role

      ORDER BY p.created_at DESC
      `,
      [req.user.id],
    );

    // Return all accessible projects.
    return ok(res, result.rows);
  } catch (error) {
    // Show actual error in backend terminal.
    console.error("List projects error:", error);

    // Send error to frontend.
    return fail(
      res,
      error.status || 500,
      error.status ? error.message : "Unable to load projects.",
    );
  }
}

// ============================================================
// CREATE PROJECT
// ============================================================

// This function creates a new project
// inside an organization.
async function createProject(req, res) {
  const client = await pool.connect();
  try {
    // Get data sent from frontend.
    const { organizationId, name, description = "" } = req.body;

    if (!isPositiveIntegerId(organizationId)) {
      return fail(res, 400, "A valid organization ID is required.");
    }

    // Check whether logged-in user
    // is an admin of this organization.
    await requireOrgAdmin(req.user.id, organizationId);

    // Project name is required.
    if (typeof name !== "string" || !name.trim() || name.trim().length > 160) {
      return fail(res, 400, "Project name is required and must be 160 characters or fewer.");
    }
    if (typeof description !== "string") {
      return fail(res, 400, "Project description must be text.");
    }

    // Insert project into projects table.
    await client.query("BEGIN");

    const result = await client.query(
      `INSERT INTO projects (organization_id, name, description, created_by) 
       VALUES ($1, $2, $3, $4) 
       RETURNING *`,
      [organizationId, name.trim(), description, req.user.id],
    );

    // Get newly created project.
    const project = result.rows[0];

    // Automatically add the creator
    // as project_admin.
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role) 
       VALUES ($1, $2, 'project_admin') 
       ON CONFLICT DO NOTHING`,
      [project.id, req.user.id],
    );

    // A project owns its workflow and optional task disciplines from the
    // moment it is created; this keeps new projects consistent with the
    // migration backfill for existing projects.
    await seedProjectWorkflow(client, project.id);
    await client.query("COMMIT");

    reindexProjectInBackground(project.id);

    // Send successful response.
    return created(res, project, "Project created.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // Show error in terminal.
    console.error("Create project error:", error);

    // Send error response.
    return fail(
      res,
      error.status || 500,
      error.status ? error.message : "Unable to create project.",
    );
  } finally {
    client.release();
  }
}

// ============================================================
// GET PROJECT
// ============================================================

// This function gets one project by its ID.
// ============================================================
// GET SINGLE PROJECT
// ============================================================

// ============================================================
// GET SINGLE PROJECT
// ============================================================

async function getProject(req, res) {
  try {
    const projectId = req.params.id;

    // --------------------------------------------------------
    // Get project only if the logged-in user belongs
    // to the project's organization.
    // --------------------------------------------------------

    const result = await pool.query(
      `
      SELECT

        -- Project information
        p.id,
        p.organization_id,
        p.name,
        p.description,
        p.status,
        p.created_by,
        p.created_at,
        p.updated_at,


        -- Organization information
        o.name AS organization_name,


        -- Project creator
        creator.name AS creator_name,


        -- Logged-in user's role in this organization
        viewer.role AS my_org_role,

        -- A project administrator has management access even when they are
        -- not an organization administrator.
        viewer_project.role AS my_project_role,


        -- Number of project members
        COUNT(
          DISTINCT pm.user_id
        )::int AS member_count,


        -- Organization admins
        COALESCE(
          string_agg(
            DISTINCT admin_user.name,
            ', '
            ORDER BY admin_user.name
          ),
          ''
        ) AS organization_admin_names


      FROM projects p


      -- Project belongs to organization
      INNER JOIN organizations o
        ON o.id = p.organization_id


      -- Logged-in user must belong to
      -- this organization
      INNER JOIN organization_members viewer
        ON viewer.organization_id = p.organization_id
       AND viewer.user_id = $2

      LEFT JOIN project_members viewer_project
        ON viewer_project.project_id = p.id
       AND viewer_project.user_id = $2


      -- Project creator
      LEFT JOIN users creator
        ON creator.id = p.created_by


      -- Project members
      LEFT JOIN project_members pm
        ON pm.project_id = p.id


      -- Organization admins
      LEFT JOIN organization_members admin_member
        ON admin_member.organization_id = p.organization_id
       AND admin_member.role IN ('owner', 'admin')


      -- Admin user information
      LEFT JOIN users admin_user
        ON admin_user.id = admin_member.user_id


      WHERE p.id = $1
        AND (
          viewer.role = 'owner'
          OR viewer_project.user_id IS NOT NULL
        )


      GROUP BY
        p.id,
        o.name,
        creator.name,
        viewer.role,
        viewer_project.role


      `,
      [projectId, req.user.id],
    );

    // --------------------------------------------------------
    // Project does not exist OR user does not belong
    // to its organization.
    // --------------------------------------------------------

    if (!result.rowCount) {
      return fail(res, 404, "Project not found or you do not have access.");
    }

    // --------------------------------------------------------
    // Return project
    // --------------------------------------------------------

    return ok(res, result.rows[0]);
  } catch (error) {
    console.error("Get project error:", error);

    return fail(res, 500, "Unable to load project.");
  }
}
// ============================================================
// UPDATE PROJECT
// ============================================================

// This function updates an existing project.
async function updateProject(req, res) {
  try {
    // Get project ID from URL.
    const { id } = req.params;

    // First find which organization
    // this project belongs to.
    const project = await pool.query(
      "SELECT organization_id FROM projects WHERE id = $1",
      [id],
    );

    // If project does not exist.
    if (!project.rowCount) return fail(res, 404, "Project not found.");

    // Project owners and project admins can update the project. Organization
    // admins do not get automatic project management rights.
    const access = await pool.query(
      `SELECT EXISTS (
          SELECT 1 FROM organization_members om
          WHERE om.organization_id = $1 AND om.user_id = $2 AND om.role = 'owner'
        ) AS is_owner,
        EXISTS (
          SELECT 1 FROM project_members pm
          WHERE pm.project_id = $3 AND pm.user_id = $2 AND pm.role = 'project_admin'
            AND EXISTS (
              SELECT 1 FROM organization_members om
              WHERE om.organization_id = $1 AND om.user_id = pm.user_id
            )
        ) AS is_project_admin`,
      [project.rows[0].organization_id, req.user.id, id],
    );
    if (!(access.rows[0]?.is_owner || access.rows[0]?.is_project_admin)) {
      return fail(res, 403, "Project administrator permission required.");
    }

    // Get updated data from frontend.
    //
    // status defaults to "active"
    // if frontend doesn't send it.
    const { name, description = "", status = "active" } = req.body;

    // Project name is required.
    if (typeof name !== "string" || !name.trim() || name.trim().length > 160) {
      return fail(res, 400, "Project name is required and must be 160 characters or fewer.");
    }
    if (typeof description !== "string") {
      return fail(res, 400, "Project description must be text.");
    }
    if (!["active", "completed", "archived"].includes(status)) {
      return fail(res, 400, "Invalid project status.");
    }

    // Update project in database.
    const result = await pool.query(
      `UPDATE projects 
       SET name = $1, description = $2, status = $3, updated_at = NOW() 
       WHERE id = $4 
       RETURNING *`,
      [name.trim(), description, status, id],
    );

    reindexProjectInBackground(result.rows[0].id);

    // Return updated project.
    return ok(res, result.rows[0], "Project updated.");
  } catch (error) {
    // Show error in terminal.
    console.error("Update project error:", error);

    // Send error response.
    return fail(
      res,
      error.status || 500,
      error.status ? error.message : "Unable to update project.",
    );
  }
}

// ============================================================
// DELETE PROJECT
// ============================================================

// This function deletes a project.
async function deleteProject(req, res) {
  try {
    // Get project ID from URL.
    const { id } = req.params;

    // Find the organization of this project.
    const project = await pool.query(
      "SELECT organization_id FROM projects WHERE id = $1",
      [id],
    );

    // If project does not exist.
    if (!project.rowCount) return fail(res, 404, "Project not found.");

    // Organization owners can manage any project in the org. Project admins may
    // also delete the project they administer, but org admins do not receive
    // automatic project-level management rights.
    const access = await pool.query(
      `SELECT EXISTS (
          SELECT 1 FROM organization_members om
          WHERE om.organization_id = $1 AND om.user_id = $2 AND om.role = 'owner'
        ) AS is_owner,
        EXISTS (
          SELECT 1 FROM project_members pm
          WHERE pm.project_id = $3 AND pm.user_id = $2 AND pm.role = 'project_admin'
            AND EXISTS (
              SELECT 1 FROM organization_members om
              WHERE om.organization_id = $1 AND om.user_id = pm.user_id
            )
        ) AS is_project_admin`,
      [project.rows[0].organization_id, req.user.id, id],
    );
    if (!(access.rows[0]?.is_owner || access.rows[0]?.is_project_admin)) {
      return fail(res, 403, "Project administrator permission required.");
    }

    // Delete project from database.
    await pool.query("DELETE FROM projects WHERE id = $1", [id]);

    // Send successful response.
    return ok(res, null, "Project deleted.");
  } catch (error) {
    // Show error in terminal.
    console.error("Delete project error:", error);

    // Send error response.
    return fail(
      res,
      error.status || 500,
      error.status ? error.message : "Unable to delete project.",
    );
  }
}

// ============================================================
// LIST PROJECT MEMBERS
// ============================================================

// This function gets all members
// of a particular project.
async function listMembers(req, res) {
  try {
    // Get project ID from URL
    const { id } = req.params;

    // Find which organization this project belongs to
    const project = await pool.query(
      `SELECT organization_id
       FROM projects
       WHERE id = $1`,
      [id],
    );

    // If project does not exist
    if (!project.rowCount) {
      return fail(res, 404, "Project not found.");
    }

    // Get organization ID
    const organizationId = project.rows[0].organization_id;

    // Users can view project member lists only when they can access the project.
    // Organization owners can always view project members; project members and
    // project admins can also view them once they're assigned to the project.
    const access = await pool.query(
      `SELECT EXISTS (
          SELECT 1 FROM organization_members om
          WHERE om.organization_id = $1 AND om.user_id = $2 AND om.role = 'owner'
        ) AS is_owner,
        EXISTS (
          SELECT 1 FROM project_members pm
          WHERE pm.project_id = $3 AND pm.user_id = $2
            AND EXISTS (
              SELECT 1 FROM organization_members om
              WHERE om.organization_id = $1 AND om.user_id = pm.user_id
            )
        ) AS is_project_member`,
      [organizationId, req.user.id, id],
    );
    if (!(access.rows[0]?.is_owner || access.rows[0]?.is_project_member)) {
      return fail(res, 403, "Project access required.");
    }

    // Get only members assigned to THIS project
    const result = await pool.query(
      `SELECT
         pm.user_id,
         pm.role,
         u.name,
         u.email
       FROM project_members pm
       INNER JOIN users u ON u.id = pm.user_id
       JOIN projects p ON p.id = pm.project_id
       JOIN organization_members om
         ON om.organization_id = p.organization_id
        AND om.user_id = pm.user_id
       WHERE pm.project_id = $1
       ORDER BY u.name`,
      [id],
    );

    // Return project members
    return ok(res, result.rows);
  } catch (error) {
    console.error("List project members error:", error);

    return fail(
      res,
      error.status || 500,
      error.status ? error.message : "Unable to load project members.",
    );
  }
}

// ============================================================
// ADD PROJECT MEMBER
// ============================================================

// This function adds a user to a project.
async function addMember(req, res) {
  try {
    // Get project ID from URL.
    const { id } = req.params;

    // Find the project's organization.
    const project = await pool.query(
      `SELECT organization_id FROM projects WHERE id = $1`,
      [id],
    );

    // Project does not exist.
    if (!project.rowCount) return fail(res, 404, "Project not found.");

    // Only the organization owner or an assigned project admin can manage the
    // project member list. Organization admins do not gain automatic project
    // management rights across every project.
    const access = await pool.query(
      `SELECT EXISTS (
          SELECT 1 FROM organization_members om
          WHERE om.organization_id = $1 AND om.user_id = $2 AND om.role = 'owner'
        ) AS is_owner,
        EXISTS (
          SELECT 1 FROM project_members pm
          WHERE pm.project_id = $3 AND pm.user_id = $2 AND pm.role = 'project_admin'
            AND EXISTS (
              SELECT 1 FROM organization_members om
              WHERE om.organization_id = $1 AND om.user_id = pm.user_id
            )
        ) AS is_project_admin`,
      [project.rows[0].organization_id, req.user.id, id],
    );
    if (!(access.rows[0]?.is_owner || access.rows[0]?.is_project_admin)) {
      return fail(res, 403, "Project administrator permission required.");
    }

    // Resolve a registered account by email rather than accepting an opaque
    // user id from the browser.
    const { email, role = "member" } = req.body;

    // Check userId and role.
    //
    // Allowed roles:
    // project_admin
    // member
    if (!email || !String(email).trim() || !["project_admin", "member"].includes(role)) {
      return fail(res, 400, "Valid email and role are required.");
    }

    const user = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [String(email).trim().toLowerCase()],
    );

    if (!user.rowCount) {
      return fail(res, 404, "No account found for that email.");
    }

    const userId = user.rows[0].id;

    // Check whether target user
    // belongs to the same organization.
    const member = await pool.query(
      `SELECT 1 FROM organization_members 
       WHERE organization_id = $1 AND user_id = $2`,
      [project.rows[0].organization_id, userId],
    );

    // If user is not part of the organization,
    // they cannot be added to its project.
    if (!member.rowCount) {
      return fail(
        res,
        403,
        "This person must be a member of the organization before they can be added to a project.",
      );
    }

    // Add user to project_members.
    //
    // If user is already a project member,
    // update their role instead.
    const result = await pool.query(
      `INSERT INTO project_members (project_id, user_id, role) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (project_id, user_id) 
       DO UPDATE SET role = EXCLUDED.role 
       RETURNING *`,
      [id, userId, role],
    );

    // Send successful response.
    return created(res, result.rows[0], "Project member added.");
  } catch (error) {
    // Show error in terminal.
    console.error("Add project member error:", error);

    // Send error response.
    return fail(
      res,
      error.status || 500,
      error.status ? error.message : "Unable to add project member.",
    );
  }
}

// ============================================================
// REMOVE PROJECT MEMBER
// ============================================================

// This function removes a user
// from a project.
async function removeMember(req, res) {
  try {
    // Get project ID and user ID from URL.
    //
    // Example:
    // DELETE /projects/10/members/5
    //
    // id = 10
    // userId = 5
    const { id, userId } = req.params;

    // Find project's organization.
    const project = await pool.query(
      "SELECT organization_id FROM projects WHERE id = $1",
      [id],
    );

    // Project doesn't exist.
    if (!project.rowCount) return fail(res, 404, "Project not found.");

    // Only the organization owner or an assigned project admin can remove
    // project members. Organization admins do not gain automatic project
    // management rights across every project.
    const access = await pool.query(
      `SELECT EXISTS (
          SELECT 1 FROM organization_members om
          WHERE om.organization_id = $1 AND om.user_id = $2 AND om.role = 'owner'
        ) AS is_owner,
        EXISTS (
          SELECT 1 FROM project_members pm
          WHERE pm.project_id = $3 AND pm.user_id = $2 AND pm.role = 'project_admin'
            AND EXISTS (
              SELECT 1 FROM organization_members om
              WHERE om.organization_id = $1 AND om.user_id = pm.user_id
            )
        ) AS is_project_admin`,
      [project.rows[0].organization_id, req.user.id, id],
    );
    if (!(access.rows[0]?.is_owner || access.rows[0]?.is_project_admin)) {
      return fail(res, 403, "Project administrator permission required.");
    }

    // Remove user from project.
    await pool.query(
      `DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`,
      [id, userId],
    );

    // Send successful response.
    return ok(res, null, "Project member removed.");
  } catch (error) {
    // Show error in terminal.
    console.error("Remove project member error:", error);

    // Send error response.
    return fail(
      res,
      error.status || 500,
      error.status ? error.message : "Unable to remove project member.",
    );
  }
}

// ============================================================
// EXPORT FUNCTIONS
// ============================================================

// Export all controller functions.
// Routes file can import these functions.
module.exports = {
  listProjects,
  createProject,
  getProject,
  updateProject,
  deleteProject,
  listMembers,
  addMember,
  removeMember,
};
