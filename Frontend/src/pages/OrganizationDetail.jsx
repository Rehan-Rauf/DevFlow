import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../services/api";
import Button from "../components/ui/Button";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import EmptyState from "../components/ui/EmptyState";
import InlineNotice from "../components/ui/InlineNotice";
import Modal from "../components/ui/Modal";
import SelectField from "../components/ui/SelectField";
import SectionCard from "../components/ui/SectionCard";
import "../styles/organization.css";

/** Manages an organization and shows its members and projects in one place. */
export default function OrganizationDetail() {
  const { id } = useParams();
  const [organization, setOrganization] = useState(null);
  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [projects, setProjects] = useState([]);
  const [memberForm, setMemberForm] = useState({ email: "", role: "user" });
  const [settingsForm, setSettingsForm] = useState({
    name: "",
    description: "",
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [expandedMemberId, setExpandedMemberId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Fetch related records together so counts and permissions describe one snapshot.
  const loadOrganization = async () => {
    try {
      setError("");
      const [organizationResponse, membersResponse, projectsResponse] =
        await Promise.all([
          api.getOrganization(id),
          api.members(id),
          api.projects(id),
        ]);
      const nextOrganization =
        organizationResponse.data || organizationResponse;
      setOrganization(nextOrganization);
      setSettingsForm({
        name: nextOrganization.name || "",
        description: nextOrganization.description || "",
      });
      setMembers(membersResponse.data || []);
      setProjects(projectsResponse.data || []);
      const nextRole = nextOrganization.my_role;
      if (["owner", "admin"].includes(nextRole)) {
        const invitationsResponse = await api.invitations(id);
        setInvitations(invitationsResponse.data || []);
      } else {
        setInvitations([]);
      }
    } catch (requestError) {
      setError(requestError.message || "Unable to load organization.");
    }
  };

  useEffect(() => {
    loadOrganization();
    const handleAIAction = (event) => {
      const resource = event.detail?.resource;
      if (
        event.detail?.resourceType === "project"
        && String(resource?.organization_id) === String(id)
      ) {
        loadOrganization();
      }
    };
    window.addEventListener("devflow:ai-action-completed", handleAIAction);
    return () => window.removeEventListener("devflow:ai-action-completed", handleAIAction);
  }, [id]);

  const saveOrganization = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api.updateOrganization(id, {
        name: settingsForm.name.trim(),
        description: settingsForm.description.trim(),
      });
      await loadOrganization();
      setSettingsOpen(false);
      setSuccess("Organization details updated.");
    } catch (requestError) {
      setError(requestError.message || "Unable to save organization changes.");
    } finally {
      setBusy(false);
    }
  };

  const addMember = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const response = await api.addMember(id, {
        email: memberForm.email.trim(),
        role: memberForm.role,
      });
      setMemberForm({ email: "", role: "user" });
      await loadOrganization();
      setSuccess(response.message || "Invitation created.");
    } catch (requestError) {
      setError(requestError.message || "Unable to add member.");
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async () => {
    if (!removeTarget) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api.removeMember(id, removeTarget.user_id);
      setRemoveTarget(null);
      await loadOrganization();
      setSuccess("Member removed.");
    } catch (requestError) {
      setError(requestError.message || "Unable to remove member.");
    } finally {
      setBusy(false);
    }
  };

  const updateMemberRole = async (member, role) => {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const response = await api.updateMember(id, member.user_id, { role });
      await loadOrganization();
      setSuccess(response.message || "Member role updated.");
    } catch (requestError) {
      setError(requestError.message || "Unable to update member role.");
    } finally {
      setBusy(false);
    }
  };

  const revokeInvitation = async () => {
    if (!revokeTarget) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api.revokeInvitation(id, revokeTarget.id);
      setRevokeTarget(null);
      await loadOrganization();
      setSuccess("Invitation cancelled.");
    } catch (requestError) {
      setError(requestError.message || "Unable to cancel invitation.");
    } finally {
      setBusy(false);
    }
  };

  if (!organization) {
    return (
      <section className="page">
        <EmptyState
          icon={error ? "!" : "…"}
          title={error ? "Organization unavailable" : "Loading organization"}
          description={error || "Gathering your workspace details."}
        />
      </section>
    );
  }

  const isOwner = organization.my_role === "owner";
  const isAdmin = isOwner || organization.my_role === "admin";

  return (
    <section className="page">
      <header className="ui-page-header">
        <div className="ui-page-header__content">
          <Link to="/organizations" className="back-link">
            ← Organizations
          </Link>
          <p className="eyebrow">Organization</p>
          <h1>{organization.name}</h1>
          <p className="muted">
            {organization.description || "Your organization workspace"}
          </p>
        </div>
        <span className="ui-badge">{isOwner ? "Owner" : isAdmin ? "Administrator" : "User"}</span>
      </header>

      {error && <InlineNotice>{error}</InlineNotice>}
      {success && <InlineNotice tone="success">{success}</InlineNotice>}

      <div className="project-summary">
        <div>
          <span>Members</span>
          <b>{members.length}</b>
        </div>
        <div>
          <span>Projects</span>
          <b>{projects.length}</b>
        </div>
        <div>
          <span>Your access</span>
          <b>{isOwner ? "Owner" : isAdmin ? "Admin" : "User"}</b>
        </div>
      </div>

      {isAdmin && (
        <div className="two-col organization-admin-grid">
          <SectionCard className="organization-details-card">
            <p className="eyebrow">Settings</p>
            <h2>Organization details</h2>

            <div className="organization-details">
              <div className="organization-detail-item">
                <span className="organization-detail-label">Name</span>
                <strong>{organization.name}</strong>
              </div>

              <div className="organization-detail-item">
                <span className="organization-detail-label">Description</span>
                <p className="organization-detail-description">
                  {organization.description || "No description added yet."}
                </p>
              </div>
            </div>

            {isOwner && (
              <Button variant="secondary" onClick={() => setSettingsOpen(true)}>
                Edit organization
              </Button>
            )}
          </SectionCard>
          <SectionCard className="organization-admin-action-card">
            <p className="eyebrow">Admin action</p>
            <h2>Add a member</h2>
            <p className="muted">
              Send an invitation by email, then choose the organization
              access level.
            </p>
            <form className="stack-form" onSubmit={addMember}>
              <label className="ui-field">
                Email address
                <input
                  type="email"
                  value={memberForm.email}
                  onChange={(event) =>
                    setMemberForm({ ...memberForm, email: event.target.value })
                  }
                  placeholder="person@example.com"
                  required
                />
              </label>
              <label className="ui-field">
                Role
                <SelectField
                  value={memberForm.role}
                  onChange={(event) =>
                    setMemberForm({ ...memberForm, role: event.target.value })
                  }
                  aria-label="Member role"
                  options={[
                    { value: "user", label: "User" },
                    ...(isOwner
                      ? [{ value: "admin", label: "Administrator" }]
                      : []),
                  ]}
                />
              </label>
              <Button type="submit" loading={busy}>
                Send invitation
              </Button>
            </form>
          </SectionCard>
        </div>
      )}

      <div className="two-col organization-content-grid">
        <SectionCard className="people-members-card">
          <div className="section-header">
            <div>
              <p className="eyebrow">People</p>
              <h2>Members</h2>
            </div>
            <span className="count-badge">{members.length}</span>
          </div>
          {members.length ? (
            <div className="member-grid">
              {members.map((member) => {
                const isExpanded = expandedMemberId === member.user_id;
                const toggleMember = () =>
                  setExpandedMemberId(isExpanded ? null : member.user_id);

                return (
                  <div
                    className={`member-item ${isExpanded ? "is-expanded" : ""}`}
                    key={member.user_id}
                    role="button"
                    tabIndex="0"
                    aria-expanded={isExpanded}
                    onClick={toggleMember}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleMember();
                      }
                    }}
                  >
                    <div className="avatar">
                      {member.name?.[0]?.toUpperCase() || "U"}
                    </div>
                    <div className="member-meta">
                      <b>{member.name}</b>
                      <p>{member.email}</p>
                    </div>
                    <span className="role-pill">
                      {member.role === "admin"
                        ? "Admin"
                        : member.role === "owner"
                          ? "Owner"
                          : "User"}
                    </span>
                    {isExpanded && (
                      <div className="member-details">
                        <span>Account status: {member.status || "Active"}</span>
                        <span>
                          Organization access:{" "}
                          {member.role === "admin"
                            ? "Administrator"
                            : member.role === "owner"
                              ? "Owner"
                              : "User"}
                        </span>
                      </div>
                    )}
                    {isExpanded && isOwner && member.role !== "owner" ? (
                      <label
                        className="member-role-control"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <span className="sr-only">
                          Change {member.name}&apos;s role
                        </span>
                        <SelectField
                          value={member.role}
                          onChange={(event) =>
                            updateMemberRole(member, event.target.value)
                          }
                          disabled={busy}
                          aria-label={`Change ${member.name}'s role`}
                          triggerLabel="Change Role"
                          options={[
                            { value: "user", label: "User" },
                            { value: "admin", label: "Admin" },
                          ]}
                        />
                      </label>
                    ) : null}
                    {isAdmin &&
                      member.role !== "owner" &&
                      (isOwner || member.role === "user") && (
                        <Button
                          variant="ghost"
                          className="organization-remove-member"
                          onClick={(event) => {
                            event.stopPropagation();
                            setRemoveTarget(member);
                          }}
                          disabled={busy}
                        >
                          Remove
                        </Button>
                      )}
                  </div>
                );
              })}
          </div>
          ) : (
            <EmptyState icon="◎" title="No members yet" description="Organization members will appear here." />
          )}
        </SectionCard>

        {isAdmin && (
          <SectionCard>
            <div className="section-header">
              <div>
                <p className="eyebrow">Invitations</p>
                <h2>Invitation status</h2>
              </div>
              <span className="count-badge">{invitations.length}</span>
            </div>
            {invitations.length ? (
              <div className="invitation-list">
                {invitations.map((invitation) => (
                  <div className="invitation-row" key={invitation.id}>
                    <div>
                      <b>{invitation.email}</b>
                      <span>{invitation.role === "admin" ? "Admin" : "User"} · invited by {invitation.invited_by_name}</span>
                    </div>
                    <span className={`invitation-status invitation-status--${invitation.status}`}>{invitation.status}</span>
                    {invitation.status === "pending" && (isOwner || invitation.role === "user") && (
                      <Button variant="ghost" onClick={() => setRevokeTarget(invitation)} disabled={busy}>Cancel</Button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState icon="✉" title="No invitations yet" description="Sent invitations and their current status will appear here." />
            )}
          </SectionCard>
        )}

        <SectionCard>
          <div className="section-header">
            <div>
              <p className="eyebrow">Work</p>
              <h2>Projects</h2>
            </div>
            <span className="count-badge">{projects.length}</span>
          </div>
          {projects.length ? (
            <div className="compact-list">
              {projects.map((project) => (
                <Link
                  to={`/projects/${project.id}`}
                  className="list-row"
                  key={project.id}
                >
                  <div>
                    <b>{project.name}</b>
                    <span>{project.description || "No description"}</span>
                  </div>
                  <span>→</span>
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState
              icon="◫"
              title="No projects yet"
              description="Projects created for this organization will appear here."
            />
          )}
        </SectionCard>
      </div>

      <Modal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Edit organization"
        closeDisabled={busy}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setSettingsOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="organization-settings-form"
              loading={busy}
            >
              Save changes
            </Button>
          </>
        }
      >
        <form
          id="organization-settings-form"
          className="stack-form"
          onSubmit={saveOrganization}
        >
          <label className="ui-field">
            Name
            <input
              value={settingsForm.name}
              onChange={(event) =>
                setSettingsForm({ ...settingsForm, name: event.target.value })
              }
              required
            />
          </label>
          <label className="ui-field">
            Description
            <textarea
              value={settingsForm.description}
              onChange={(event) =>
                setSettingsForm({
                  ...settingsForm,
                  description: event.target.value,
                })
              }
              placeholder="Describe your team or workspace."
            />
          </label>
        </form>
      </Modal>

      <ConfirmDialog
        isOpen={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={removeMember}
        busy={busy}
        title="Remove member"
        description={`Remove ${removeTarget?.name || "this member"} from the organization? This action can't be undone.`}
        confirmLabel="Remove member"
      />
      <ConfirmDialog
        isOpen={Boolean(revokeTarget)}
        onClose={() => setRevokeTarget(null)}
        onConfirm={revokeInvitation}
        busy={busy}
        title="Cancel invitation"
        description={`Cancel the invitation sent to ${revokeTarget?.email || "this email address"}?`}
        confirmLabel="Cancel invitation"
      />
    </section>
  );
}
