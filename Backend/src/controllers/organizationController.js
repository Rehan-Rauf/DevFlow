const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { makeToken } = require("./authController");
const pool = require("../config/database");
const { ok, created, fail } = require("../utils/response");
const knowledgeBaseService = require("../services/knowledgeBaseService");
const {
  requireOrganizationMember,
  requireOrganizationAdminOrOwner,
  requireOrganizationOwner,
} = require("../middleware/authorizationMiddleware");
const { sendOrganizationInvitation } = require("../services/emailService");

function reindexOrgInBackground(id) {
  knowledgeBaseService.indexOrganization(id)
    .catch((error) => console.error(`Knowledge reindex failed for organization ${id}:`, error.message));
}

async function createOrganization(req, res) {
  const client = await pool.connect();
  try {
    const { name, description = "" } = req.body;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 160) {
      return fail(res, 400, "Organization name is required and must be 160 characters or fewer.");
    }
    if (typeof description !== "string") {
      return fail(res, 400, "Organization description must be text.");
    }
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO organizations (name, description, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, name, description, created_by, created_at, updated_at`,
      [name.trim(), description, req.user.id],
    );
    const organization = result.rows[0];
    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [organization.id, req.user.id],
    );
    await client.query("COMMIT");
    reindexOrgInBackground(organization.id);
    return created(res, organization, "Organization created. You are its owner.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Create organization error:", error);
    return fail(res, error.status || 500, error.status ? error.message : "Unable to create organization.");
  } finally {
    client.release();
  }
}

async function listOrganizations(req, res) {
  try {
    const result = await pool.query(
      `SELECT o.id, o.name, o.description, o.created_by, o.created_at, o.updated_at,
              om.role AS my_role,
              COUNT(DISTINCT members.id)::int AS member_count,
              COUNT(DISTINCT admins.id)::int AS admin_count
       FROM organizations o
       JOIN organization_members om ON om.organization_id = o.id AND om.user_id = $1
       LEFT JOIN organization_members members ON members.organization_id = o.id
       LEFT JOIN organization_members admins
         ON admins.organization_id = o.id AND admins.role IN ('owner', 'admin')
       GROUP BY o.id, om.role
       ORDER BY o.created_at DESC`,
      [req.user.id],
    );
    return ok(res, result.rows);
  } catch (error) {
    console.error("List organizations error:", error);
    return fail(res, 500, "Unable to load organizations.");
  }
}

async function getOrganization(req, res) {
  try {
    const result = await pool.query(
      `SELECT o.*, om.role AS my_role
       FROM organizations o
       JOIN organization_members om ON om.organization_id = o.id AND om.user_id = $2
       WHERE o.id = $1`,
      [req.params.id, req.user.id],
    );
    if (!result.rowCount) return fail(res, 404, "Organization not found.");
    return ok(res, result.rows[0]);
  } catch (error) {
    console.error("Get organization error:", error);
    return fail(res, 500, "Unable to load organization.");
  }
}

async function updateOrganization(req, res) {
  try {
    await requireOrganizationOwner(req.user.id, req.params.id);
    const { name, description = "" } = req.body;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 160) {
      return fail(res, 400, "Organization name is required and must be 160 characters or fewer.");
    }
    if (typeof description !== "string") {
      return fail(res, 400, "Organization description must be text.");
    }
    const result = await pool.query(
      `UPDATE organizations SET name = $1, description = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [name.trim(), description, req.params.id],
    );
    reindexOrgInBackground(result.rows[0].id);
    return ok(res, result.rows[0], "Organization updated.");
  } catch (error) {
    console.error("Update organization error:", error);
    return fail(res, error.status || 500, error.status ? error.message : "Unable to update organization.");
  }
}

async function deleteOrganization(req, res) {
  try {
    await requireOrganizationOwner(req.user.id, req.params.id);
    await pool.query("DELETE FROM organizations WHERE id = $1", [req.params.id]);
    return ok(res, null, "Organization deleted.");
  } catch (error) {
    console.error("Delete organization error:", error);
    return fail(res, error.status || 500, error.status ? error.message : "Unable to delete organization.");
  }
}

async function listMembers(req, res) {
  try {
    await requireOrganizationMember(req.user.id, req.params.id);
    const result = await pool.query(
      `SELECT om.id, om.organization_id, om.user_id, om.role, om.created_at,
              u.name, u.email, u.status
       FROM organization_members om JOIN users u ON u.id = om.user_id
       WHERE om.organization_id = $1
       ORDER BY CASE om.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.name`,
      [req.params.id],
    );
    return ok(res, result.rows);
  } catch (error) {
    console.error("List members error:", error);
    return fail(res, error.status || 500, error.status ? error.message : "Unable to load organization members.");
  }
}

async function addMember(req, res) {
  try {
    const actor = await requireOrganizationAdminOrOwner(req.user.id, req.params.id);
    const { email, role = "user" } = req.body;
    if (!email?.trim() || !["admin", "user"].includes(role)) {
      return fail(res, 400, "A valid email and role are required.");
    }
    if (actor.role !== "owner" && role !== "user") {
      return fail(res, 403, "Administrators can only invite users.");
    }
    const normalizedEmail = email.trim().toLowerCase();
    const organization = await pool.query(
      `SELECT o.name, inviter.name AS inviter_name
       FROM organizations o JOIN users inviter ON inviter.id = $2
       WHERE o.id = $1`,
      [req.params.id, req.user.id],
    );
    if (!organization.rowCount) return fail(res, 404, "Organization not found.");
    const existingUser = await pool.query("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
    if (existingUser.rowCount) {
      const membership = await pool.query(
        `SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
        [req.params.id, existingUser.rows[0].id],
      );
      if (membership.rowCount) return fail(res, 409, "User is already a member.");
    }
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await pool.query(
      `UPDATE organization_invitations SET status = 'revoked', updated_at = NOW()
       WHERE organization_id = $1 AND email = $2 AND status = 'pending'`,
      [req.params.id, normalizedEmail],
    );
    const invitation = await pool.query(
      `INSERT INTO organization_invitations
       (organization_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days')
       RETURNING id, organization_id, email, role, status, expires_at, created_at`,
      [req.params.id, normalizedEmail, role, tokenHash, req.user.id],
    );
    console.info(
      `Organization invitation created: id=${invitation.rows[0].id}, ` +
      `organization=${req.params.id}, recipient=${normalizedEmail.replace(/^(.).+(@.*)$/, "$1***$2")}`,
    );
    const emailResult = await sendOrganizationInvitation({
      email: normalizedEmail,
      organizationName: organization.rows[0].name,
      role,
      inviterName: organization.rows[0].inviter_name,
      token: rawToken,
    });
    return created(
      res,
      { ...invitation.rows[0], email_sent: emailResult.sent },
      emailResult.sent ? "Invitation created and email sent." : "Invitation created; email was not sent.",
    );
  } catch (error) {
    console.error("Create invitation error:", error);
    return fail(res, error.status || 500, error.status ? error.message : "Unable to create invitation.");
  }
}

async function updateMember(req, res) {
  const client = await pool.connect();
  try {
    await requireOrganizationOwner(req.user.id, req.params.id, client);
    const { role } = req.body;
    if (!["admin", "user"].includes(role)) return fail(res, 400, "Role must be admin or user.");
    await client.query("BEGIN");
    const member = await client.query(
      `SELECT role FROM organization_members
       WHERE organization_id = $1 AND user_id = $2 FOR UPDATE`,
      [req.params.id, req.params.userId],
    );
    if (!member.rowCount) {
      await client.query("ROLLBACK");
      return fail(res, 404, "Organization member not found.");
    }
    if (member.rows[0].role === "owner") {
      await client.query("ROLLBACK");
      return fail(res, 403, "Organization owner role cannot be modified.");
    }
    const result = await client.query(
      `UPDATE organization_members SET role = $1, updated_at = NOW()
       WHERE organization_id = $2 AND user_id = $3 RETURNING *`,
      [role, req.params.id, req.params.userId],
    );
    await client.query("COMMIT");
    return ok(res, result.rows[0], "Member role updated.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Update member error:", error);
    return fail(res, error.status || 500, error.status ? error.message : "Unable to update member.");
  } finally {
    client.release();
  }
}

async function removeMember(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const actor = await requireOrganizationAdminOrOwner(req.user.id, req.params.id, client);
    const member = await client.query(
      `SELECT role FROM organization_members
       WHERE organization_id = $1 AND user_id = $2
       FOR UPDATE`,
      [req.params.id, req.params.userId],
    );
    if (!member.rowCount) {
      await client.query("ROLLBACK");
      return fail(res, 404, "Organization member not found.");
    }
    if (member.rows[0].role === "owner") {
      await client.query("ROLLBACK");
      return fail(res, 403, "Organization owner cannot be removed.");
    }
    if (actor.role !== "owner" && member.rows[0].role !== "user") {
      await client.query("ROLLBACK");
      return fail(res, 403, "Administrators can only remove users.");
    }
    await client.query(
      `DELETE FROM project_members pm
       USING projects p
       WHERE pm.project_id = p.id
         AND p.organization_id = $1
         AND pm.user_id = $2`,
      [req.params.id, req.params.userId],
    );
    await client.query(
      `DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
      [req.params.id, req.params.userId],
    );
    await client.query("COMMIT");
    return ok(res, null, "Member removed.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Remove member error:", error);
    return fail(res, error.status || 500, error.status ? error.message : "Unable to remove member.");
  } finally {
    client.release();
  }
}

async function getInvitation(req, res) {
  try {
    const hash = crypto.createHash("sha256").update(String(req.params.token)).digest("hex");
    const result = await pool.query(
      `SELECT i.email, i.role, i.status, i.expires_at, o.name AS organization_name,
              EXISTS (SELECT 1 FROM users invited_user WHERE lower(invited_user.email) = lower(i.email)) AS account_exists,
              u.name AS inviter_name
       FROM organization_invitations i
       JOIN organizations o ON o.id = i.organization_id
       JOIN users u ON u.id = i.invited_by
       WHERE i.token_hash = $1`,
      [hash],
    );
    if (!result.rowCount) return fail(res, 404, "Invitation not found.");
    if (result.rows[0].status !== "pending" || new Date(result.rows[0].expires_at) <= new Date()) {
      return fail(res, 410, "This invitation is no longer valid.");
    }

    return ok(res, result.rows[0]);
  } catch (error) {
    console.error("Get invitation error:", error);
    return fail(res, 500, "Unable to load invitation.");
  }
}

async function listInvitations(req, res) {
  try {
    await requireOrganizationAdminOrOwner(req.user.id, req.params.id);
    const result = await pool.query(
      `SELECT i.id, i.email, i.role, i.status, i.expires_at, i.created_at,
              u.name AS invited_by_name
       FROM organization_invitations i
       JOIN users u ON u.id = i.invited_by
       WHERE i.organization_id = $1
       ORDER BY i.created_at DESC`,
      [req.params.id],
    );
    return ok(res, result.rows);
  } catch (error) {
    console.error("List invitations error:", error);
    return fail(res, error.status || 500, error.status ? error.message : "Unable to load invitations.");
  }
}

async function acceptInvitationAndCreateAccount(req, res) {
  const client = await pool.connect();
  try {
    const name = String(req.body?.name || "").trim();
    const password = req.body?.password;
    if (typeof password !== "string" || !password) {
      return fail(res, 400, "Password is required.");
    }

    const hash = crypto.createHash("sha256").update(String(req.params.token)).digest("hex");
    await client.query("BEGIN");
    const invitationResult = await client.query(
      `SELECT id, organization_id, email, role, status, expires_at
       FROM organization_invitations
       WHERE token_hash = $1
       FOR UPDATE`,
      [hash],
    );
    if (!invitationResult.rowCount) {
      await client.query("ROLLBACK");
      return fail(res, 404, "Invitation not found.");
    }
    const invitation = invitationResult.rows[0];
    if (invitation.status !== "pending") {
      await client.query("ROLLBACK");
      return fail(res, 410, "This invitation is no longer valid.");
    }
    if (new Date(invitation.expires_at) <= new Date()) {
      await client.query("ROLLBACK");
      return fail(res, 410, "This invitation has expired.");
    }

    const existing = await client.query(
      `SELECT id, name, email, password, role, status, auth_version, created_at
       FROM users WHERE lower(email) = lower($1) FOR UPDATE`,
      [invitation.email],
    );
    let user;
    if (existing.rowCount) {
      user = existing.rows[0];
      if (user.status !== "active" || !(await bcrypt.compare(password, user.password))) {
        await client.query("ROLLBACK");
        return fail(res, 401, "Invalid email or password.");
      }
      delete user.password;
    } else {
      if (!name || name.length > 120) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Name is required for a new account.");
      }
      if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) ||
          !/[0-9]/.test(password) || !/[!@#$%^&*(),.?":{}|<>_\-\\[\]~`+/;'=]/.test(password)) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Password does not meet the required security rules.");
      }

      const hashedPassword = await bcrypt.hash(password, 12);
      const userResult = await client.query(
        `INSERT INTO users (name, email, password)
         VALUES ($1, lower($2), $3)
         RETURNING id, name, email, role, status, auth_version, created_at`,
        [name, invitation.email, hashedPassword],
      );
      user = userResult.rows[0];
    }

    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, $3)`,
      [invitation.organization_id, user.id, invitation.role],
    );
    await client.query(
      `UPDATE organization_invitations
       SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [invitation.id],
    );
    await client.query("COMMIT");
    return created(res, {
      user,
      token: makeToken(user),
      organizationId: invitation.organization_id,
      role: invitation.role,
    }, existing.rowCount ? "Invitation accepted." : "Account created and invitation accepted.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") {
      return fail(res, 409, "This invitation has already been accepted or membership already exists.");
    }
    console.error("Accept invitation and create account error:", error);
    return fail(res, 500, "Unable to create the account from this invitation.");
  } finally {
    client.release();
  }
}

async function revokeInvitation(req, res) {
  try {
    const actor = await requireOrganizationAdminOrOwner(req.user.id, req.params.id);
    const result = await pool.query(
      `SELECT role FROM organization_invitations
       WHERE id = $1 AND organization_id = $2 AND status = 'pending'`,
      [req.params.invitationId, req.params.id],
    );
    if (!result.rowCount) return fail(res, 404, "Pending invitation not found.");
    if (actor.role !== "owner" && result.rows[0].role !== "user") {
      return fail(res, 403, "Administrators can only revoke user invitations.");
    }
    await pool.query(
      `UPDATE organization_invitations
       SET status = 'revoked', updated_at = NOW()
       WHERE id = $1`,
      [req.params.invitationId],
    );
    return ok(res, null, "Invitation revoked.");
  } catch (error) {
    console.error("Revoke invitation error:", error);
    return fail(res, error.status || 500, error.status ? error.message : "Unable to revoke invitation.");
  }
}

async function acceptInvitation(req, res) {
  const client = await pool.connect();
  try {
    const hash = crypto.createHash("sha256").update(String(req.params.token)).digest("hex");
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT id, organization_id, email, role, status, expires_at
       FROM organization_invitations WHERE token_hash = $1 FOR UPDATE`,
      [hash],
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return fail(res, 404, "Invitation not found.");
    }
    const invitation = result.rows[0];
    if (invitation.status !== "pending" || new Date(invitation.expires_at) <= new Date()) {
      await client.query("ROLLBACK");
      return fail(res, 410, "This invitation is no longer valid.");
    }
    const user = await client.query("SELECT email FROM users WHERE id = $1", [req.user.id]);
    if (!user.rowCount || user.rows[0].email.toLowerCase() !== invitation.email.toLowerCase()) {
      await client.query("ROLLBACK");
      return fail(res, 403, "This invitation was sent to a different email address.");
    }
    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, $3)`,
      [invitation.organization_id, req.user.id, invitation.role],
    );
    await client.query(
      `UPDATE organization_invitations SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [invitation.id],
    );
    await client.query("COMMIT");
    return ok(res, { organizationId: invitation.organization_id, role: invitation.role }, "Invitation accepted.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Accept invitation error:", error);
    if (error.code === "23505") {
      return fail(res, 409, "You are already a member of this organization.");
    }
    return fail(res, error.status || 500, error.status ? error.message : "Unable to accept invitation.");
  } finally {
    client.release();
  }
}

module.exports = {
  createOrganization,
  listOrganizations,
  getOrganization,
  updateOrganization,
  deleteOrganization,
  listMembers,
  addMember,
  updateMember,
  removeMember,
  getInvitation,
  listInvitations,
  revokeInvitation,
  acceptInvitation,
  acceptInvitationAndCreateAccount,
};
