const pool = require("../config/database");

function forbidden(message) {
  const error = new Error(message);
  error.status = 403;
  return error;
}

async function getOrganizationMembership(userId, organizationId, client = pool) {
  const result = await client.query(
    `SELECT role FROM organization_members
     WHERE organization_id = $1 AND user_id = $2
     FOR SHARE`,
    [organizationId, userId],
  );
  return result.rows[0] || null;
}

async function requireOrganizationMember(userId, organizationId, client = pool) {
  const membership = await getOrganizationMembership(userId, organizationId, client);
  if (!membership) throw forbidden("You are not a member of this organization.");
  return membership;
}

async function requireOrganizationAdminOrOwner(userId, organizationId, client = pool) {
  const membership = await requireOrganizationMember(userId, organizationId, client);
  if (!["owner", "admin"].includes(membership.role)) {
    throw forbidden("Organization administrator permission required.");
  }
  return membership;
}

async function requireOrganizationOwner(userId, organizationId, client = pool) {
  const membership = await requireOrganizationMember(userId, organizationId, client);
  if (membership.role !== "owner") throw forbidden("Organization owner permission required.");
  return membership;
}

module.exports = {
  getOrganizationMembership,
  requireOrganizationMember,
  requireOrganizationAdminOrOwner,
  requireOrganizationOwner,
};
