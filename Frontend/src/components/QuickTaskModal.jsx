import { useEffect, useState } from "react";
import { api } from "../services/api";
import Modal from "./ui/Modal";
import SelectField from "./ui/SelectField";
import "../styles/task-quick-create.css";

const EMPTY_FORM = { title: "", description: "", priority: "medium" };

function responseData(response) {
  return response?.data?.data || response?.data || response || {};
}

function responseArray(response) {
  const data = responseData(response);
  return Array.isArray(data) ? data : [];
}

export default function QuickTaskModal({ isOpen, context, onClose, onSuccess }) {
  const [organizations, setOrganizations] = useState([]);
  const [projects, setProjects] = useState([]);
  const [organizationId, setOrganizationId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;

    async function loadContext() {
      setLoading(true);
      setError("");
      setForm(EMPTY_FORM);
      setOrganizationId("");
      setProjectId("");
      setStatus("");
      setProjects([]);
      try {
        const orgs = responseArray(await api.organizations());
        if (cancelled) return;
        setOrganizations(orgs);

        let nextOrgId = "";
        let nextProjectId = "";
        if (context?.entityType === "organization") {
          const organization = responseData(await api.getOrganization(context.entityId));
          nextOrgId = String(organization.id || context.entityId);
        } else if (context?.entityType === "project") {
          const project = responseData(await api.getProject(context.entityId));
          nextOrgId = String(project.organization_id || project.organizationId || "");
          nextProjectId = String(project.id || context.entityId);
        } else if (context?.entityType === "task") {
          const task = responseData(await api.getTask(context.entityId));
          nextOrgId = String(task.organization_id || task.organizationId || "");
          nextProjectId = String(task.project_id || task.projectId || "");
          if (!nextOrgId && nextProjectId) {
            const project = responseData(await api.getProject(nextProjectId));
            nextOrgId = String(project.organization_id || project.organizationId || "");
          }
        }
        if (cancelled) return;

        if (nextOrgId && !orgs.some((organization) => String(organization.id) === nextOrgId)) {
          throw new Error("The current organization is not available to your account.");
        }
        setOrganizationId(nextOrgId);

        if (nextOrgId) {
          const availableProjects = responseArray(await api.projects(nextOrgId));
          if (cancelled) return;
          setProjects(availableProjects);
          if (nextProjectId && availableProjects.some((project) => String(project.id) === nextProjectId)) {
            setProjectId(nextProjectId);
            const statusOptions = responseArray(await api.projectStatuses(nextProjectId));
            if (cancelled) return;
            setStatus(statusOptions.find((item) => item.key === "todo")?.key || statusOptions[0]?.key || "");
          }
        }
      } catch (loadError) {
        if (!cancelled) {
          console.error("Unable to load quick task context:", loadError);
          setError(loadError.message || "Unable to load organizations and projects.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadContext();
    return () => { cancelled = true; };
  }, [isOpen, context?.entityType, context?.entityId]);

  async function handleOrganizationChange(event) {
    const nextOrganizationId = event.target.value;
    setOrganizationId(nextOrganizationId);
    setProjectId("");
    setStatus("");
    setProjects([]);
    setError("");
    if (!nextOrganizationId) return;
    setLoading(true);
    try {
      setProjects(responseArray(await api.projects(nextOrganizationId)));
    } catch (loadError) {
      console.error("Unable to load projects for quick task creation:", loadError);
      setError(loadError.message || "Unable to load projects for this organization.");
    } finally {
      setLoading(false);
    }
  }

  async function handleProjectChange(event) {
    const nextProjectId = event.target.value;
    setProjectId(nextProjectId);
    setStatus("");
    setError("");
    if (!nextProjectId) return;
    setLoading(true);
    try {
      const statusOptions = responseArray(await api.projectStatuses(nextProjectId));
      setStatus(statusOptions.find((item) => item.key === "todo")?.key || statusOptions[0]?.key || "");
    } catch (loadError) {
      console.error("Unable to load project task statuses:", loadError);
      setError(loadError.message || "Unable to load statuses for this project.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    if (!form.title.trim()) {
      setError("Task title is required.");
      return;
    }
    if (!organizationId || !projectId || !status) {
      setError(!organizationId || !projectId
        ? "Choose an organization and project before creating a task."
        : "This project does not have a valid task status available.");
      return;
    }

    setSaving(true);
    try {
      const response = await api.createTask({
        title: form.title.trim(),
        description: form.description.trim(),
        priority: form.priority,
        status,
        organizationId: Number(organizationId),
        projectId: Number(projectId),
      });
      const createdTask = responseData(response);
      window.dispatchEvent(new CustomEvent("devflow:task-created", {
        detail: { ...createdTask, projectId: Number(projectId), organizationId: Number(organizationId) },
      }));
      onSuccess({ ...createdTask, title: createdTask.title || form.title.trim() });
    } catch (createError) {
      console.error("Quick task creation failed:", createError);
      setError(createError.message || "Unable to create task.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      closeDisabled={saving}
      title="Create task"
      className="quick-task-modal"
      footer={(
        <>
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" form="quick-task-form" className="ui-button ui-button--primary" disabled={loading || saving}>
            {saving ? "Creating…" : "Create task"}
          </button>
        </>
      )}
    >
      <form id="quick-task-form" className="quick-task-form" onSubmit={handleSubmit}>
        {error && <p className="quick-task-error" role="alert">{error}</p>}
        {loading && <p className="quick-task-status" role="status">Loading available projects…</p>}
        <label>
          Organization
          <SelectField
            value={organizationId}
            onChange={handleOrganizationChange}
            disabled={loading || saving}
            placeholder="Select organization"
            aria-label="Organization"
            options={organizations.map((organization) => ({ value: organization.id, label: organization.name }))}
          />
        </label>
        <label>
          Project
          <SelectField
            value={projectId}
            onChange={handleProjectChange}
            disabled={!organizationId || loading || saving}
            placeholder={organizationId ? "Select project" : "Select organization first"}
            aria-label="Project"
            options={projects.map((project) => ({ value: project.id, label: project.name }))}
          />
        </label>
        <label>
          Task title
          <input
            autoFocus
            value={form.title}
            onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
            maxLength={200}
            required
            disabled={loading || saving}
          />
        </label>
        <label>
          Description <span className="quick-task-optional">Optional</span>
          <textarea
            value={form.description}
            onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
            rows={3}
            maxLength={5000}
            disabled={loading || saving}
          />
        </label>
        <label>
          Priority
          <SelectField
            value={form.priority}
            onChange={(event) => setForm((current) => ({ ...current, priority: event.target.value }))}
            disabled={loading || saving}
            aria-label="Priority"
            options={[
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
              { value: "urgent", label: "Urgent" },
            ]}
          />
        </label>
      </form>
    </Modal>
  );
}
