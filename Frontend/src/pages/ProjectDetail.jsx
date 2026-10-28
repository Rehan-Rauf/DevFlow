import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { io } from "socket.io-client";
import { api } from "../services/api";
import TaskBoard from "../components/TaskBoard";
import Button from "../components/ui/Button";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import EmptyState from "../components/ui/EmptyState";
import InlineNotice from "../components/ui/InlineNotice";
import Modal from "../components/ui/Modal";
import SelectField from "../components/ui/SelectField";
import SectionCard from "../components/ui/SectionCard";
import { TASK_PRIORITIES } from "../constants/taskWorkflow";

import "../styles/task.css";
import "../styles/project-detail.css";

const EMPTY_TASK_FORM = {
  title: "",
  description: "",
  status: "",
  priority: "no_priority",
  assigneeId: "",
  roleTagId: "",
  dueDate: "",
};

const EMPTY_MEMBER_FORM = { email: "", role: "member" };
const EMPTY_STATUS = { label: "", color: "#8b7cff" };
const EMPTY_ROLE = { label: "", descriptionTemplate: "" };

function getDefaultStatus(statuses) {
  return statuses.find((status) => status.key === "todo")?.key || statuses[0]?.key || "";
}

function isManager(project) {
  return project?.my_org_role === "owner" || project?.my_project_role === "project_admin";
}

/** Project workspace with a project-owned workflow and discipline tags. */
export default function ProjectDetail() {
  const { id } = useParams();
  const [project, setProject] = useState(null);
  const [members, setMembers] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [statuses, setStatuses] = useState([]);
  const [roleTags, setRoleTags] = useState([]);
  const [form, setForm] = useState(EMPTY_TASK_FORM);
  const [memberForm, setMemberForm] = useState(EMPTY_MEMBER_FORM);
  const [draggingId, setDraggingId] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [roleModalOpen, setRoleModalOpen] = useState(false);
  const [statusDraft, setStatusDraft] = useState(EMPTY_STATUS);
  const [roleDraft, setRoleDraft] = useState(EMPTY_ROLE);
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [expandedMemberId, setExpandedMemberId] = useState(null);
  const taskTitleRef = useRef(null);

  const loadProject = async () => {
    try {
      setError("");
      const projectResponse = await api.getProject(id);
      const nextProject = projectResponse.data || projectResponse;
      const [membersResponse, tasksResponse, statusesResponse, roleTagsResponse] = await Promise.all([
        api.projectMembers(id),
        api.tasks(id),
        api.projectStatuses(id),
        api.projectRoleTags(id),
      ]);
      const nextStatuses = statusesResponse.data || [];
      setProject(nextProject);
      setMembers(membersResponse.data || []);
      setTasks(tasksResponse.data || []);
      setStatuses(nextStatuses);
      setRoleTags(roleTagsResponse.data || []);
      setForm((current) => ({
        ...current,
        status: nextStatuses.some((status) => status.key === current.status)
          ? current.status
          : getDefaultStatus(nextStatuses),
      }));
    } catch (requestError) {
      setError(requestError.message || "Unable to load project workspace.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProject();
    const socket = io(import.meta.env.VITE_SOCKET_URL || "http://localhost:5001", {
      auth: { token: localStorage.getItem("cms_token") },
    });
    socket.on("task_changed", loadProject);
    const refreshAfterQuickCreate = (event) => {
      if (String(event.detail?.projectId || event.detail?.project_id) === String(id)) loadProject();
    };
    window.addEventListener("devflow:task-created", refreshAfterQuickCreate);
    return () => {
      socket.disconnect();
      window.removeEventListener("devflow:task-created", refreshAfterQuickCreate);
    };
  }, [id]);

  const updateTaskForm = (field, value) => {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === "roleTagId") {
        const tag = roleTags.find((item) => String(item.id) === String(value));
        // A template makes starting easier but never replaces typed content.
        if (tag?.description_template && !current.description.trim()) next.description = tag.description_template;
      }
      return next;
    });
  };

  const startTaskInStatus = (status) => {
    setForm((current) => ({ ...current, status }));
    document.querySelector(".project-create-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
    requestAnimationFrame(() => taskTitleRef.current?.focus());
  };

  const createTask = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.createTask({
        projectId: Number(id),
        title: form.title.trim(),
        description: form.description.trim(),
        status: form.status,
        priority: form.priority,
        assigneeId: form.assigneeId ? Number(form.assigneeId) : null,
        roleTagId: form.roleTagId ? Number(form.roleTagId) : null,
        dueDate: form.dueDate || null,
      });
      setForm({ ...EMPTY_TASK_FORM, status: getDefaultStatus(statuses) });
      await loadProject();
    } catch (requestError) {
      setError(requestError.message || "Unable to create task.");
    } finally {
      setBusy(false);
    }
  };

  const moveTask = async (taskId, nextStatus) => {
    const task = tasks.find((item) => String(item.id) === String(taskId));
    if (!task || task.status === nextStatus) return;
    const previousTasks = tasks;
    setTasks((current) => current.map((item) => String(item.id) === String(taskId) ? { ...item, status: nextStatus } : item));
    try {
      await api.updateTask(taskId, { status: nextStatus });
    } catch (requestError) {
      setTasks(previousTasks);
      setError(requestError.message || "Unable to move task.");
    }
  };

  const addProjectMember = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.addProjectMember(id, { email: memberForm.email.trim(), role: memberForm.role });
      setMemberForm(EMPTY_MEMBER_FORM);
      await loadProject();
    } catch (requestError) {
      setError(requestError.message || "Unable to add project member.");
    } finally {
      setBusy(false);
    }
  };

  const saveStatus = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (statusDraft.id) await api.updateProjectStatus(id, statusDraft.id, statusDraft);
      else await api.createProjectStatus(id, statusDraft);
      setStatusModalOpen(false);
      setStatusDraft(EMPTY_STATUS);
      await loadProject();
    } catch (requestError) {
      setError(requestError.message || "Unable to save status.");
    } finally {
      setBusy(false);
    }
  };

  const reorderStatuses = async (fromIndex, direction) => {
    const toIndex = fromIndex + direction;
    if (toIndex < 0 || toIndex >= statuses.length) return;
    const previous = statuses;
    const reordered = [...statuses];
    [reordered[fromIndex], reordered[toIndex]] = [reordered[toIndex], reordered[fromIndex]];
    setStatuses(reordered);
    try {
      await api.reorderProjectStatuses(id, reordered.map((status) => status.id));
    } catch (requestError) {
      setStatuses(previous);
      setError(requestError.message || "Unable to reorder statuses.");
    }
  };

  const saveRoleTag = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (roleDraft.id) await api.updateProjectRoleTag(id, roleDraft.id, roleDraft);
      else await api.createProjectRoleTag(id, roleDraft);
      setRoleModalOpen(false);
      setRoleDraft(EMPTY_ROLE);
      await loadProject();
    } catch (requestError) {
      setError(requestError.message || "Unable to save role tag.");
    } finally {
      setBusy(false);
    }
  };

  const performConfirmedAction = async () => {
    if (!confirmTarget) return;
    setBusy(true);
    setError("");
    try {
      if (confirmTarget.type === "member") await api.removeProjectMember(id, confirmTarget.item.user_id);
      if (confirmTarget.type === "status") await api.deleteProjectStatus(id, confirmTarget.item.id);
      if (confirmTarget.type === "role") await api.deleteProjectRoleTag(id, confirmTarget.item.id);
      setConfirmTarget(null);
      await loadProject();
    } catch (requestError) {
      setError(requestError.message || "Unable to complete that action.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <section className="page"><div className="screen-loader">Loading project workspace…</div></section>;

  const canManage = isManager(project);
  const confirmCopy = confirmTarget?.type === "status"
    ? "Delete this status? Tasks using it must be reassigned first. This action can't be undone."
    : confirmTarget?.type === "role"
      ? "Delete this role tag? Tasks using it must be changed first. This action can't be undone."
      : "Remove this person from the project? Their existing tasks remain. This action can't be undone.";

  return (
    <section className="page project-detail-page">
      <div className="page-header project-detail-header">
        <div>
          <Link to="/projects" className="task-project-back"><span className="task-project-back-arrow">←</span><span>Projects</span></Link>
          <p className="eyebrow">{project?.organization_name || "Organization"}</p>
          <h1>{project?.name || "Project"}</h1>
          <p className="muted">{project?.description || "Project workspace"}</p>
        </div>
        <div className="ui-page-header__actions">
          <Button
            type="button"
            variant="secondary"
            onClick={() => window.dispatchEvent(new CustomEvent("devflow:open-task-agent", {
              detail: { entityType: "project", entityId: Number(id) },
            }))}
          >
            Task Agent
          </Button>
          <span className="ui-badge">{project?.status || "Active"}</span>
        </div>
      </div>

      {error && <InlineNotice>{error}</InlineNotice>}

      <div className="project-summary">
        <div><span>Organization</span><b>{project?.organization_name || "—"}</b></div>
        <div><span>Your access</span><b>{canManage ? "Project admin" : "Member"}</b></div>
        <div><span>Tasks</span><b>{tasks.length}</b></div>
        <div><span>Members</span><b>{members.length}</b></div>
      </div>

      {canManage && (
        <SectionCard className="ui-split-card project-create-card">
          <div className="project-create-intro">
            <p className="eyebrow">Project action</p>
            <h2>Create a task</h2>
            <p className="muted">Start with an optional discipline template, then make it your own.</p>
          </div>

          <form className="project-create-form" onSubmit={createTask}>
            <div className="project-create-form__row project-create-form__row--two">
              <label className="ui-field">
                <span>Task title</span>
                <input
                  ref={taskTitleRef}
                  value={form.title}
                  onChange={(event) => updateTaskForm("title", event.target.value)}
                  placeholder={`What needs to be done in ${project?.name || "this project"}?`}
                  required
                />
              </label>

              <label className="ui-field">
                <span>Role tag</span>
                <SelectField
                  value={form.roleTagId}
                  onChange={(event) => updateTaskForm("roleTagId", event.target.value)}
                  placeholder="No role tag"
                  aria-label="Role tag"
                  options={roleTags.map((tag) => ({ value: tag.id, label: tag.label }))}
                />
              </label>
            </div>

            <div className="project-create-form__row project-create-form__row--three">
              <label className="ui-field project-create-form__description">
                <span>Description</span>
                <textarea
                  value={form.description}
                  onChange={(event) => updateTaskForm("description", event.target.value)}
                  placeholder={`Add useful context for ${project?.name || "the project"}`}
                  rows="3"
                />
              </label>

              <label className="ui-field">
                <span>Status</span>
                <SelectField
                  value={form.status}
                  onChange={(event) => updateTaskForm("status", event.target.value)}
                  aria-label="Status"
                  options={statuses.map((status) => ({ value: status.key, label: status.label }))}
                />
              </label>

              <label className="ui-field">
                <span>Assignee</span>
                <SelectField
                  value={form.assigneeId}
                  onChange={(event) => updateTaskForm("assigneeId", event.target.value)}
                  placeholder="Unassigned"
                  aria-label="Assignee"
                  options={members.map((member) => ({ value: member.user_id, label: `${member.name} · ${member.role}` }))}
                />
              </label>
            </div>

            <div className="project-create-form__row project-create-form__row--bottom">
              <label className="ui-field">
                <span>Priority</span>
                <SelectField
                  value={form.priority}
                  onChange={(event) => updateTaskForm("priority", event.target.value)}
                  aria-label="Priority"
                  options={TASK_PRIORITIES.map((priority) => ({ value: priority.id, label: priority.label }))}
                />
              </label>

              <label className="ui-field">
                <span>Due date</span>
                <input type="date" value={form.dueDate} onChange={(event) => updateTaskForm("dueDate", event.target.value)} />
              </label>

              <div className="project-create-form__action">
                <Button type="submit" loading={busy} disabled={!statuses.length}>Create task</Button>
              </div>
            </div>
          </form>
        </SectionCard>
      )}

      <SectionCard className="project-board-card">
        <div className="section-header">
          <div><p className="eyebrow">Workflow</p><h2>Project tasks</h2></div>
          <div className="section-header-actions">
            <span className="count-badge">{tasks.length}</span>
          </div>
        </div>
        {statuses.length ? <TaskBoard
          tasks={tasks}
          statuses={statuses}
          draggingId={draggingId}
          dragOverStatus={dragOver}
          onDragStart={(event, taskId) => { setDraggingId(taskId); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(taskId)); }}
          onDragEnd={() => { setDraggingId(null); setDragOver(null); }}
          onDragOver={(event, status) => { if (!canManage) return; event.preventDefault(); if (draggingId) setDragOver(status); }}
          onDragLeave={(event) => { if (event.currentTarget === event.target) setDragOver(null); }}
          onDrop={(event, status) => { event.preventDefault(); if (canManage) moveTask(draggingId, status); setDraggingId(null); setDragOver(null); }}
          onAddTask={canManage ? startTaskInStatus : undefined}
          boardHeaderActions={canManage ? (
            <button type="button" className="kanban-status-manager" onClick={() => { setStatusDraft(EMPTY_STATUS); setStatusModalOpen(true); }} disabled={busy}>
              <span className="kanban-status-manager-icon">☰</span>
              <span>Manage statuses</span>
            </button>
          ) : null}
        /> : <EmptyState icon="…" title="Loading workflow" description="Project statuses are not available yet." />}
      </SectionCard>

      {canManage && (
        <SectionCard className="ui-split-card project-member-card">
          <div className="project-member-intro">
            <p className="eyebrow">Team</p>
            <h2>Project members</h2>
            <p className="muted">They must already belong to this organization.</p>
          </div>
          <form className="project-member-form" onSubmit={addProjectMember}>
            <div className="project-member-form-grid">
              <label className="ui-field">
                <span>Email</span>
                <input type="email" value={memberForm.email} onChange={(event) => setMemberForm({ ...memberForm, email: event.target.value })} placeholder="person@example.com" required />
              </label>
              <label className="ui-field">
                <span>Project role</span>
                <SelectField
                  value={memberForm.role}
                  onChange={(event) => setMemberForm({ ...memberForm, role: event.target.value })}
                  aria-label="Project role"
                  options={[{ value: "member", label: "Member" }, { value: "project_admin", label: "Project admin" }]}
                />
              </label>
              <div className="project-member-action">
                <Button type="submit" loading={busy}>Add to project</Button>
              </div>
            </div>
          </form>
        </SectionCard>
      )}

      <SectionCard className="team-members-card">
        <div className="section-header"><div><p className="eyebrow">Team</p><h2>Project members</h2></div><span className="count-badge">{members.length}</span></div>
        {members.length ? <div className="member-grid">{members.map((member) => {
          const isExpanded = expandedMemberId === member.user_id;
          const toggleMember = () => setExpandedMemberId(isExpanded ? null : member.user_id);

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
              <div className="avatar">{member.name?.[0]?.toUpperCase() || "U"}</div>
              <div className="member-meta"><b>{member.name}</b><p>{member.email}</p></div>
              <span className="role-pill">{member.role}</span>
              {canManage && <Button variant="ghost" className="organization-remove-member" onClick={(event) => { event.stopPropagation(); setConfirmTarget({ type: "member", item: member }); }} disabled={busy}>Remove</Button>}
            </div>
          );
        })}</div> : <EmptyState icon="◫" title="No project members yet" description="Invite an organization member to start assigning work." />}
      </SectionCard>

      {canManage && <SectionCard className="role-tags-card">
        <div className="section-header"><div><p className="eyebrow">Disciplines</p><h2>Task role tags</h2></div><Button variant="secondary" onClick={() => { setRoleDraft(EMPTY_ROLE); setRoleModalOpen(true); }}>Manage role tags</Button></div>
        <div className="role-tag-list">{roleTags.map((tag) => <div className="role-tag-row" key={tag.id}><div className="role-tag-row__main"><b>{tag.label}</b><p>{tag.description_template || "No description template"}</p></div><div className="row-actions"><Button variant="ghost" onClick={() => { setRoleDraft({ id: tag.id, label: tag.label, descriptionTemplate: tag.description_template || "" }); setRoleModalOpen(true); }}>Edit</Button><Button variant="danger" onClick={() => setConfirmTarget({ type: "role", item: tag })}>Delete</Button></div></div>)}</div>
      </SectionCard>}

      <Modal isOpen={statusModalOpen} onClose={() => setStatusModalOpen(false)} title={statusDraft.id ? "Edit status" : "Manage statuses"} closeDisabled={busy} footer={<><Button variant="secondary" onClick={() => setStatusModalOpen(false)} disabled={busy}>Close</Button><Button type="submit" form="status-form" loading={busy}>{statusDraft.id ? "Save status" : "Add status"}</Button></>}>
        <form id="status-form" className="stack-form" onSubmit={saveStatus}>
          <label className="ui-field">Status name<input value={statusDraft.label} onChange={(event) => setStatusDraft({ ...statusDraft, label: event.target.value })} maxLength="80" required /></label>
          <label className="ui-field color-field">
            <span>Color</span>
            <span className="color-field-row">
              <input type="color" value={statusDraft.color || "#8b7cff"} onChange={(event) => setStatusDraft({ ...statusDraft, color: event.target.value })} className="color-input" />
              <span className="color-swatch-picker">{["#8b7cff", "#6fa8ff", "#d7b66f", "#c58bff", "#59d68c", "#ef8e99", "#7d8797"].map((color) => <button type="button" key={color} className={statusDraft.color === color ? "is-selected" : ""} style={{ backgroundColor: color }} onClick={() => setStatusDraft({ ...statusDraft, color })} aria-label={`Use ${color}`} />)}</span>
            </span>
          </label>
          <div className="status-order-list">{statuses.map((status, index) => <div className="status-order-row" key={status.id}><span className="status-dot" style={{ backgroundColor: status.color }} /><b>{status.label}</b><div><Button variant="ghost" onClick={() => setStatusDraft({ id: status.id, label: status.label, color: status.color })} disabled={busy}>Edit</Button><Button variant="ghost" onClick={() => reorderStatuses(index, -1)} disabled={busy || index === 0}>↑</Button><Button variant="ghost" onClick={() => reorderStatuses(index, 1)} disabled={busy || index === statuses.length - 1}>↓</Button><Button variant="danger" onClick={() => setConfirmTarget({ type: "status", item: status })} disabled={busy}>Delete</Button></div></div>)}</div>
        </form>
      </Modal>

      <Modal isOpen={roleModalOpen} onClose={() => setRoleModalOpen(false)} title={roleDraft.id ? "Edit role tag" : "Add role tag"} closeDisabled={busy} footer={<><Button variant="secondary" onClick={() => setRoleModalOpen(false)} disabled={busy}>Cancel</Button><Button type="submit" form="role-tag-form" loading={busy}>{roleDraft.id ? "Save role tag" : "Add role tag"}</Button></>}>
        <form id="role-tag-form" className="stack-form" onSubmit={saveRoleTag}><label className="ui-field">Role label<input value={roleDraft.label} onChange={(event) => setRoleDraft({ ...roleDraft, label: event.target.value })} maxLength="100" required /></label><label className="ui-field">Description template<textarea value={roleDraft.descriptionTemplate} onChange={(event) => setRoleDraft({ ...roleDraft, descriptionTemplate: event.target.value })} rows="7" placeholder="Optional, editable starter text for new tasks." /></label></form>
      </Modal>

      <ConfirmDialog isOpen={Boolean(confirmTarget)} onClose={() => setConfirmTarget(null)} onConfirm={performConfirmedAction} busy={busy} title={confirmTarget?.type === "status" ? "Delete status" : confirmTarget?.type === "role" ? "Delete role tag" : "Remove project member"} description={confirmCopy} confirmLabel={confirmTarget?.type === "member" ? "Remove member" : confirmTarget?.type === "status" ? "Delete status" : "Delete role tag"} />
    </section>
  );
}
