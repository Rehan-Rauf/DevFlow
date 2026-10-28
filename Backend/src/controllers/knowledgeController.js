const pool = require("../config/database");
const {
  searchKnowledge: vectorSearch,
} = require("../services/vectorSearchService");
const { isPositiveIntegerId } = require("../utils/validation");

// ============================================================
// CHECK ORGANIZATION MEMBERSHIP
// ============================================================
//
// A user must belong to organizationId to search its knowledge
// base. Without this check, a logged-in user could read another
// organization's data just by changing organizationId in the
// query string.
async function assertOrgMember(userId, organizationId) {
  const result = await pool.query(
    `SELECT 1
     FROM organization_members
     WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId]
  );

  if (!result.rowCount) {
    const error = new Error(
      "You are not a member of this organization."
    );
    error.status = 403;
    throw error;
  }
}

async function searchKnowledge(req, res) {
  try {
    const { q, organizationId, projectId, limit } = req.query;

    // Check search query
    if (!q || !q.trim()) {
      return res.status(400).json({
        success: false,
        message: "Search query is required.",
      });
    }

    // Check organization
    if (!organizationId) {
      return res.status(400).json({
        success: false,
        message: "Organization ID is required.",
      });
    }

    if (!isPositiveIntegerId(organizationId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid organization ID.",
      });
    }

    const parsedOrganizationId = Number(organizationId);

    // Make sure the logged-in user actually belongs to
    // this organization before searching its knowledge base.
    // req.user is set by requireAuth (see knowledgeRoutes.js).
    await assertOrgMember(req.user.id, parsedOrganizationId);

    // Optional project filter
    if (projectId !== undefined && projectId !== null && projectId !== "" && !isPositiveIntegerId(projectId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid project ID.",
      });
    }
    const parsedProjectId = projectId ? Number(projectId) : null;

    // Optional result limit
    const parsedLimit = limit
      ? Number(limit)
      : 8;

    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid limit.",
      });
    }

    console.log("================================");
    console.log("KNOWLEDGE SEARCH API");
    console.log("Organization:", parsedOrganizationId);
    console.log("Project:", parsedProjectId);
    console.log("Limit:", parsedLimit);
    console.log("================================");

    // IMPORTANT:
    // vectorSearchService expects ONE OBJECT
    const results = await vectorSearch({
      query: q.trim(),
      userId: req.user.id,
      organizationId: parsedOrganizationId,
      projectId: parsedProjectId,
      limit: parsedLimit,
    });

    return res.status(200).json({
      success: true,
      query: q.trim(),
      organizationId: parsedOrganizationId,
      projectId: parsedProjectId,
      count: results.length,
      results,
    });
  } catch (error) {
    console.error("Knowledge search error:", error);

    // assertOrgMember() throws a 403 error when the user
    // isn't a member of the requested organization.
    const status = error.status || 500;

    return res.status(status).json({
      success: false,
      message:
        status === 500
          ? "Knowledge search failed."
          : error.message,
    });
  }
}

module.exports = {
  searchKnowledge,
};