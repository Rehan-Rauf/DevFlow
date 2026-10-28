import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { api } from "../services/api";
import { useAuth } from "../context/AuthContext";
import TaskBoard from "../components/TaskBoard";
import Button from "../components/ui/Button";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import Modal from "../components/ui/Modal";
import SelectField from "../components/ui/SelectField";
import { TASK_WORKFLOW } from "../constants/taskWorkflow";

import "../styles/task.css";
import "../styles/ai-task.css";

// ======================================================
// TASK STATUS COLUMNS
// ======================================================

// The AI and edit forms use the same shared workflow as the board.
const cols = TASK_WORKFLOW.map(({ id, label }) => [id, label]);

// ======================================================
// EMPTY FORMS
// ======================================================

const emptyAiForm = {
  title: "",
  description: "",
  priority: "medium",
  status: "todo",
};

const emptyEditForm = {
  id: "",
  title: "",
  description: "",
  priority: "medium",
  status: "todo",
};

const EMPTY_STATUS = {
  id: "",
  label: "",
  color: "#8b7cff",
};

// ======================================================
// HELPERS
// ======================================================

const getResponseData = (response) => {
  if (!response) return {};

  if (response.data?.data) {
    return response.data.data;
  }

  return response.data || {};
};

const getArrayData = (response) => {
  if (!response) return [];

  if (Array.isArray(response.data)) {
    return response.data;
  }

  if (Array.isArray(response.data?.data)) {
    return response.data.data;
  }

  return [];
};

const getMemberId = (member) => {
  return member?.id || member?.user_id;
};

// ======================================================
// COMPONENT
// ======================================================

export default function TasksPage() {
  const { user } = useAuth();

  // ====================================================
  // TASKS
  // ====================================================

  const [tasks, setTasks] = useState([]);

  // ====================================================
  // ORGANIZATIONS
  // ====================================================

  const [orgs, setOrgs] = useState([]);

  // ====================================================
  // PROJECTS
  // ====================================================

  const [projects, setProjects] = useState([]);

  // ====================================================
  // MEMBERS
  // ====================================================

  const [members, setMembers] = useState([]);

  // ====================================================
  // AI MODAL
  // ====================================================

  const [aiOpen, setAiOpen] = useState(false);

  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedAssigneeId, setSelectedAssigneeId] = useState("");

  const [aiMessage, setAiMessage] = useState("");

  const [aiLoading, setAiLoading] = useState(false);
  const [aiTask, setAiTask] = useState(null);

  const [aiForm, setAiForm] = useState({
    ...emptyAiForm,
  });

  // ====================================================
  // GENERAL STATE
  // ====================================================

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // ====================================================
  // DRAG STATE
  // ====================================================

  const [draggingId, setDraggingId] = useState(null);
  const [dragOver, setDragOver] = useState(null);

  // ====================================================
  // STATUS MANAGEMENT MODAL STATE
  // ====================================================

  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [statusProjectId, setStatusProjectId] = useState("");
  const [statusStatusOptions, setStatusStatusOptions] = useState([]);
  const [statusDraft, setStatusDraft] = useState({ ...EMPTY_STATUS });

  // ====================================================
  // EDIT MODAL
  // ====================================================

  const [editOpen, setEditOpen] = useState(false);

  const [editForm, setEditForm] = useState({
    ...emptyEditForm,
  });

  // ====================================================
  // DELETE CONFIRMATION
  // ====================================================

  const [confirmDeleteTarget, setConfirmDeleteTarget] = useState(null);

  // ====================================================
  // PROJECT-SPECIFIC STATUS OPTIONS
  // ====================================================
  // The AI create form and edit modal must reflect each project's own
  // custom statuses instead of the fixed default workflow, since project
  // admins can rename, reorder, add, or remove statuses per project.

  const [aiStatusOptions, setAiStatusOptions] = useState(cols);
  const [editStatusOptions, setEditStatusOptions] = useState(cols);

  const fetchProjectStatusOptions = async (projectId) => {
    if (!projectId) return cols;

    try {
      const response = await api.projectStatuses(projectId);
      const data = getArrayData(response);

      if (data.length) {
        return data
          .slice()
          .sort((a, b) => Number(a.position || 0) - Number(b.position || 0))
          .map((status) => [status.key, status.label]);
      }
    } catch (err) {
      console.error("Project statuses error:", err);
    }

    return cols;
  };

  // ====================================================
  // CLEAR MESSAGES
  // ====================================================

  const clearMessages = () => {
    setError("");
    setSuccess("");
  };

  // ====================================================
  // STATUS MANAGER HELPERS
  // ====================================================

  const projectOptionsFromTasks = (rows = []) => {
    const map = new Map();

    rows.forEach((task) => {
      const projectId = task.project_id || task.projectId;
      if (!projectId) return;

      const name = task.project_name || task.projectName || `Project ${projectId}`;
      if (!map.has(String(projectId))) {
        map.set(String(projectId), {
          id: Number(projectId),
          name,
        });
      }
    });

    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  };

  const loadProjectStatuses = async (projectId) => {
    if (!projectId) {
      setStatusStatusOptions([]);
      return;
    }

    try {
      const response = await api.projectStatuses(projectId);
      const data = getArrayData(response);
      const ordered = data
        .slice()
        .sort((a, b) => Number(a.position || 0) - Number(b.position || 0));

      setStatusStatusOptions(ordered);
    } catch (err) {
      console.error("Project status load error:", err);
      setStatusStatusOptions([]);
      setError(err?.message || "Unable to load project statuses.");
    }
  };

  const openStatusManager = async () => {
    const projects = projectOptionsFromTasks(tasks);

    if (!projects.length) {
      setError("No project is attached to the tasks shown in the board.");
      return;
    }

    const defaultProject = projects[0];
    setStatusProjectId(defaultProject.id);
    setStatusDraft({ ...EMPTY_STATUS });
    setStatusModalOpen(true);

    await loadProjectStatuses(defaultProject.id);
  };

  const saveProjectStatus = async (event) => {
    event.preventDefault();

    if (!statusProjectId) {
      setError("Choose a project before updating statuses.");
      return;
    }

    try {
      setBusy(true);
      setError("");

      const payload = {
        label: statusDraft.label.trim(),
        color: statusDraft.color || "#8b7cff",
      };

      if (statusDraft.id) {
        await api.updateProjectStatus(statusProjectId, statusDraft.id, payload);
      } else {
        await api.createProjectStatus(statusProjectId, payload);
      }

      setStatusDraft({ ...EMPTY_STATUS });
      await loadProjectStatuses(statusProjectId);
      await loadTasks();
    } catch (err) {
      setError(err?.message || "Unable to save status.");
    } finally {
      setBusy(false);
    }
  };

  const deleteProjectStatus = async (status) => {
    if (!statusProjectId || !status?.id) return;

    try {
      setBusy(true);
      setError("");
      await api.deleteProjectStatus(statusProjectId, status.id);
      setStatusDraft({ ...EMPTY_STATUS });
      await loadProjectStatuses(statusProjectId);
      await loadTasks();
    } catch (err) {
      setError(err?.message || "Unable to delete status.");
    } finally {
      setBusy(false);
    }
  };

  const reorderProjectStatuses = async (fromIndex, direction) => {
    if (!statusProjectId || !statusStatusOptions.length) return;

    const toIndex = fromIndex + direction;
    if (toIndex < 0 || toIndex >= statusStatusOptions.length) return;

    const reordered = [...statusStatusOptions];
    [reordered[fromIndex], reordered[toIndex]] = [reordered[toIndex], reordered[fromIndex]];

    try {
      setBusy(true);
      await api.reorderProjectStatuses(statusProjectId, reordered.map((status) => status.id));
      setStatusStatusOptions(reordered);
      await loadTasks();
    } catch (err) {
      setError(err?.message || "Unable to reorder statuses.");
    } finally {
      setBusy(false);
    }
  };

  // ====================================================
  // LOAD TASKS
  // ====================================================

  const loadTasks = async () => {
    try {
      setLoading(true);

      const response = await api.getMyTasks();

      const data = getArrayData(response);

      setTasks(data);
    } catch (err) {
      console.error("Tasks error:", err);

      setError(err?.message || "Unable to load tasks.");
    } finally {
      setLoading(false);
    }
  };

  // ====================================================
  // LOAD ORGANIZATIONS
  // ====================================================

  const loadOrganizations = async () => {
    try {
      const response = await api.organizations();

      const data = getArrayData(response);

      setOrgs(data);
    } catch (err) {
      console.error("Organizations error:", err);

      setError(err?.message || "Unable to load organizations.");
    }
  };

  // ====================================================
  // INITIAL LOAD
  // ====================================================

  useEffect(() => {
    loadTasks();
    loadOrganizations();

    const token = localStorage.getItem("cms_token");

    const socket = io(
      import.meta.env.VITE_SOCKET_URL || "http://localhost:5001",
      {
        auth: {
          token,
        },
      },
    );

    socket.on("task_changed", () => {
      loadTasks();
    });
    window.addEventListener("devflow:task-created", loadTasks);

    return () => {
      socket.disconnect();
      window.removeEventListener("devflow:task-created", loadTasks);
    };
  }, []);

  // ====================================================
  // OPEN AI MODAL
  // ====================================================

  const openAiModal = () => {
    clearMessages();

    setAiOpen(true);

    setAiTask(null);

    setAiMessage("");

    setAiStatusOptions(cols);

    setAiForm({
      ...emptyAiForm,
    });
  };

  // ====================================================
  // CLOSE AI MODAL
  // ====================================================

  const closeAiModal = () => {
    if (aiLoading || busy) {
      return;
    }

    setAiOpen(false);

    setAiTask(null);

    setAiMessage("");

    setSelectedOrgId("");
    setSelectedProjectId("");
    setSelectedAssigneeId("");

    setProjects([]);
    setMembers([]);

    setAiForm({
      ...emptyAiForm,
    });

    clearMessages();
  };

  // ====================================================
  // ORGANIZATION CHANGE
  // ====================================================

  const handleOrganizationChange = async (e) => {
    const organizationId = e.target.value;

    clearMessages();

    setSelectedOrgId(organizationId);

    setSelectedProjectId("");
    setSelectedAssigneeId("");

    setProjects([]);
    setMembers([]);

    setAiTask(null);

    setAiForm({
      ...emptyAiForm,
    });

    if (!organizationId) {
      return;
    }

    try {
      setBusy(true);

      const [projectResponse, memberResponse] = await Promise.all([
        api.projects(organizationId),
        api.members(organizationId),
      ]);

      setProjects(getArrayData(projectResponse));

      setMembers(getArrayData(memberResponse));
    } catch (err) {
      console.error("Organization data error:", err);

      setError(err?.message || "Unable to load projects and members.");
    } finally {
      setBusy(false);
    }
  };

  // ====================================================
  // PROJECT CHANGE
  // ====================================================

  const handleProjectChange = async (e) => {
    const projectId = e.target.value;

    clearMessages();

    setSelectedProjectId(projectId);

    setSelectedAssigneeId("");

    setAiTask(null);

    if (!projectId) {
      setMembers([]);
    } else {
      try {
        const memberResponse = await api.projectMembers(projectId);
        setMembers(getArrayData(memberResponse));
      } catch (err) {
        console.error("Project members error:", err);
        setError(err?.message || "Unable to load project members.");
        setMembers([]);
      }
    }

    const statusOptions = await fetchProjectStatusOptions(projectId);

    setAiStatusOptions(statusOptions);

    setAiForm({
      ...emptyAiForm,
      status: statusOptions[0]?.[0] || emptyAiForm.status,
    });
  };

  // ====================================================
  // ASSIGNEE CHANGE
  // ====================================================

  const handleAssigneeChange = (e) => {
    setSelectedAssigneeId(e.target.value);
  };

  // ====================================================
  // SELECTED ORGANIZATION
  // ====================================================

  const getSelectedOrganization = () => {
    return orgs.find((org) => Number(org.id) === Number(selectedOrgId));
  };

  // ====================================================
  // SELECTED PROJECT
  // ====================================================

  const getSelectedProject = () => {
    return projects.find(
      (project) => Number(project.id) === Number(selectedProjectId),
    );
  };

  // ====================================================
  // SELECTED MEMBER
  // ====================================================

  const getSelectedMember = () => {
    return members.find(
      (member) => Number(getMemberId(member)) === Number(selectedAssigneeId),
    );
  };

  // ====================================================
  // BASIC PROMPT VALIDATION
  // ====================================================

  const validatePromptBeforeAI = (message) => {
    const value = message.trim();

    if (!value) {
      return "Tell AI what you need to build, fix, improve, or complete.";
    }

    if (value.length < 10) {
      return "Give a little more detail so AI can create a useful task.";
    }

    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "");

    if (!normalized) {
      return "Please enter a meaningful task description.";
    }

    if (new Set(normalized).size === 1 && normalized.length >= 8) {
      return "Please describe a real task related to this project.";
    }

    const uniqueCharacters = new Set(normalized).size;

    if (normalized.length >= 15 && uniqueCharacters <= 2) {
      return "Please describe a meaningful task related to this project.";
    }

    const letters = value.match(/[a-zA-Z]/g) || [];

    if (letters.length < 5) {
      return "Please enter a meaningful task description.";
    }

    return null;
  };

  // ====================================================
  // AI ANALYSIS
  // ====================================================

  const analyzeWithAI = async () => {
    clearMessages();

    if (!selectedOrgId) {
      setError("Select an organization first.");
      return;
    }

    if (!selectedProjectId) {
      setError("Select a project first.");
      return;
    }

    const message = aiMessage.trim();

    const validationError = validatePromptBeforeAI(message);

    if (validationError) {
      setError(validationError);
      return;
    }

    const organization = getSelectedOrganization();

    const project = getSelectedProject();

    if (!organization) {
      setError("Selected organization could not be found.");
      return;
    }

    if (!project) {
      setError("Selected project could not be found.");
      return;
    }

    try {
      setAiLoading(true);

      const response = await api.analyzeTask({
        message,

        organizationId: Number(selectedOrgId),

        projectId: Number(selectedProjectId),
      });

      const result = getResponseData(response);

      console.log("AI ANALYSIS RESULT:", result);

      if (
        result.valid === false ||
        result.isValid === false ||
        result.related === false
      ) {
        setAiTask(null);

        setError(
          result.reason ||
            result.message ||
            "This request does not appear to belong to the selected project.",
        );

        return;
      }

      if (!result.title || !result.description) {
        setAiTask(null);

        setError(
          "AI could not create a valid task. Please provide a little more detail.",
        );

        return;
      }

      const generatedTask = {
        ...result,

        organizationId: Number(selectedOrgId),

        projectId: Number(selectedProjectId),
      };

      setAiTask(generatedTask);

      setAiForm({
        title: result.title.trim(),

        description: result.description.trim(),

        priority: result.priority || "medium",

        status: result.status || "todo",
      });

      setSuccess("AI reviewed your request and prepared a task.");
    } catch (err) {
      console.error("AI task analysis error:", err);

      setAiTask(null);

      setError(
        err?.message || "AI is temporarily unavailable. Please try again.",
      );
    } finally {
      setAiLoading(false);
    }
  };

  // ====================================================
  // CREATE TASK FROM AI
  // ====================================================

  const createTaskFromAI = async () => {
    clearMessages();

    if (!aiTask) {
      setError("Analyze the task with AI first.");
      return;
    }

    if (!aiForm.title.trim()) {
      setError("Task title is required.");
      return;
    }

    if (!aiForm.description.trim()) {
      setError("Task description is required.");
      return;
    }

    try {
      setBusy(true);

      const payload = {
        title: aiForm.title.trim(),

        description: aiForm.description.trim(),

        priority: aiForm.priority || "medium",

        status: aiForm.status || "todo",

        organizationId: Number(selectedOrgId),

        projectId: Number(selectedProjectId),

        assigneeId: selectedAssigneeId ? Number(selectedAssigneeId) : null,
      };

      console.log("CREATE AI TASK PAYLOAD:", payload);

      await api.createTask(payload);

      setAiOpen(false);

      setAiTask(null);

      setAiMessage("");

      setSelectedOrgId("");
      setSelectedProjectId("");
      setSelectedAssigneeId("");

      setProjects([]);
      setMembers([]);

      setAiForm({
        ...emptyAiForm,
      });

      setSuccess("Task created successfully.");

      await loadTasks();
    } catch (err) {
      console.error("Create task error:", err);

      setError(err?.message || "Unable to create task.");
    } finally {
      setBusy(false);
    }
  };

  // ====================================================
  // TASK PERMISSION
  // ====================================================

  const isOrganizationAdmin = (task) => {
    if (!task) return false;

    const organization = orgs.find(
      (org) =>
        Number(org.id) === Number(task.organization_id || task.organizationId),
    );

    return ["owner", "admin"].includes(organization?.my_role);
  };

  const canManageTask = (task) => {
    if (!task || !user) {
      return false;
    }

    if (isOrganizationAdmin(task)) {
      return true;
    }

    if (
      task.created_by &&
      user.id &&
      Number(task.created_by) === Number(user.id)
    ) {
      return true;
    }

    if (
      task.assignee_id &&
      user.id &&
      Number(task.assignee_id) === Number(user.id)
    ) {
      return true;
    }

    return false;
  };

  // ====================================================
  // DRAG START
  // ====================================================

  const handleDragStart = (e, taskId) => {
    setDraggingId(taskId);

    e.dataTransfer.effectAllowed = "move";

    e.dataTransfer.setData("text/plain", String(taskId));
  };

  // ====================================================
  // DRAG END
  // ====================================================

  const handleDragEnd = () => {
    setDraggingId(null);
    setDragOver(null);
  };

  // ====================================================
  // DROP TASK
  // ====================================================

  const dropTask = async (newStatus) => {
    if (!draggingId) return;

    const id = draggingId;

    const task = tasks.find((item) => String(item.id) === String(id));

    setDragOver(null);

    if (!task) {
      setDraggingId(null);
      return;
    }

    if (task.status === newStatus) {
      setDraggingId(null);
      return;
    }

    if (!canManageTask(task)) {
      setDraggingId(null);

      setError("You do not have permission to change this task.");

      return;
    }

    const previousTasks = [...tasks];

    setTasks((previous) =>
      previous.map((item) =>
        String(item.id) === String(id)
          ? {
              ...item,
              status: newStatus,
            }
          : item,
      ),
    );

    setDraggingId(null);
    setError("");

    try {
      await api.updateTask(id, {
        status: newStatus,
      });
    } catch (err) {
      console.error("Status update error:", err);

      setTasks(previousTasks);

      setError(err?.message || "Unable to change task status.");
    }
  };

  // ====================================================
  // EDIT
  // ====================================================

  const startEdit = async (task) => {
    if (!canManageTask(task)) {
      setError("You do not have permission to edit this task.");
      return;
    }

    clearMessages();

    setEditForm({
      id: task.id,

      title: task.title || "",

      description: task.description || "",

      priority: task.priority || "medium",

      status: task.status || "todo",
    });

    setEditOpen(true);

    // Load this task's own project statuses so the dropdown only ever
    // offers statuses that actually exist for that project.
    const statusOptions = await fetchProjectStatusOptions(task.project_id);

    setEditStatusOptions(statusOptions);
  };

  // ====================================================
  // UPDATE
  // ====================================================

  const updateTask = async (e) => {
    e.preventDefault();

    clearMessages();

    if (!editForm.title.trim()) {
      setError("Task title is required.");
      return;
    }

    try {
      setBusy(true);

      await api.updateTask(editForm.id, {
        title: editForm.title.trim(),

        description: editForm.description.trim(),

        priority: editForm.priority,

        status: editForm.status,
      });

      setEditOpen(false);

      setEditForm({
        ...emptyEditForm,
      });

      setSuccess("Task updated successfully.");

      await loadTasks();
    } catch (err) {
      console.error("Update task error:", err);

      setError(err?.message || "Unable to update task.");
    } finally {
      setBusy(false);
    }
  };

  // ====================================================
  // DELETE
  // ====================================================

  const requestDeleteTask = (task) => {
    if (!canManageTask(task)) {
      setError("You do not have permission to delete this task.");
      return;
    }

    setConfirmDeleteTarget(task);
  };

  const confirmDeleteTask = async () => {
    const task = confirmDeleteTarget;

    if (!task) return;

    try {
      setBusy(true);

      clearMessages();

      await api.deleteTask(task.id);

      setSuccess("Task deleted successfully.");

      await loadTasks();
    } catch (err) {
      console.error("Delete task error:", err);

      setError(err?.message || "Unable to delete task.");
    } finally {
      setBusy(false);

      setConfirmDeleteTarget(null);
    }
  };

  // ====================================================
  // RENDER
  // ====================================================

  return (
    <section className="page tasks-page">
      {/* ==================================================
          HEADER
          ================================================== */}

      <div className="tasks-header">
        <div className="tasks-heading">
          <div className="tasks-heading-icon">✓</div>

          <div>
            <p className="eyebrow">Live workflow</p>

            <h1>Tasks</h1>

            <p className="muted tasks-intro">
              Turn ideas into organized work, track progress, and keep your team
              moving.
            </p>
          </div>
        </div>

        <div className="tasks-header-actions">
          <button
            type="button"
            className="tasks-agent-action"
            onClick={() => window.dispatchEvent(new CustomEvent("devflow:open-task-agent"))}
            title="Choose a task for the Task Agent"
          >
            <span aria-hidden="true">✦</span>
            Task Agent
          </button>
          <button
            type="button"
            className="create-ai-button"
            onClick={openAiModal}
            disabled={loading}
          >
            <span className="create-ai-icon">✦</span>

            <span>
              <strong>Create with AI</strong>

              <small>Turn an idea into a task</small>
            </span>

            <span className="create-ai-arrow">→</span>
          </button>
        </div>
      </div>

      {/* ==================================================
          GLOBAL SUCCESS
          ================================================== */}

      {success && !aiOpen && (
        <div className="task-alert success">
          <span>✓</span>
          {success}
        </div>
      )}

      {/* ==================================================
          GLOBAL ERROR
          ================================================== */}

      {error && !aiOpen && (
        <div className="task-alert error">
          <span>!</span>
          {error}
        </div>
      )}

      {/* ==================================================
          WORKSPACE SUMMARY
          ================================================== */}

      <div className="task-workspace-bar">
        <div className="workspace-stat">
          <span className="workspace-stat-number">{tasks.length}</span>

          <span className="workspace-stat-label">Total tasks</span>
        </div>

        <div className="workspace-divider" />

        <div className="workspace-stat">
          <span className="workspace-stat-number">
            {tasks.filter((task) => task.status === "in_progress").length}
          </span>

          <span className="workspace-stat-label">In progress</span>
        </div>

        <div className="workspace-divider" />

        <div className="workspace-stat">
          <span className="workspace-stat-number">
            {tasks.filter((task) => task.status === "done").length}
          </span>

          <span className="workspace-stat-label">Completed</span>
        </div>

        <div className="workspace-spacer" />

        <span className="live-indicator">
          <span />
          Live
        </span>
      </div>

      {/* ==================================================
          LOADING
          ================================================== */}

      {loading && (
        <div className="tasks-loading">
          <div className="loading-spinner" />
          Loading your tasks...
        </div>
      )}

      {/* ==================================================
          KANBAN
          ================================================== */}

      <TaskBoard
        tasks={tasks}
        statuses={statusStatusOptions}
        draggingId={draggingId}
        dragOverStatus={dragOver}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={(event, status) => {
          event.preventDefault();
          if (draggingId) setDragOver(status);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDragOver(null);
        }}
        onDrop={(event, status) => {
          event.preventDefault();
          dropTask(status);
        }}
        showProject
        boardHeaderActions={
          <button type="button" className="kanban-status-manager" onClick={openStatusManager} disabled={loading || busy}>
            <span className="kanban-status-manager-icon">☰</span>
            <span>Manage statuses</span>
          </button>
        }
        renderTaskActions={(task) => canManageTask(task) && (
          <div className="task-actions">
            <button type="button" className="task-edit-btn" onClick={() => startEdit(task)} disabled={busy}>Edit</button>
            <button type="button" className="task-delete-btn" onClick={() => requestDeleteTask(task)} disabled={busy}>Delete</button>
          </div>
        )}
      />

      {/* ==================================================
          AI CREATE MODAL
          ================================================== */}

      {aiOpen && (
        <div
          className="ai-modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !aiLoading && !busy) {
              closeAiModal();
            }
          }}
        >
          <div className="ai-modal">
            {/* HEADER */}

            <div className="ai-modal-header">
              {/* ==================================================
    CREATE WITH AI
    ================================================== */}

              <div className="ai-launch-card">
                <div className="ai-launch-icon">✦</div>

                <div className="ai-launch-content">
                  <div className="ai-launch-title-row">
                    <h2>Create with AI</h2>

                    <span className="ai-badge">AI</span>
                  </div>

                  <p>
                    Turn an idea into a structured task in seconds. Describe
                    what you need and AI will organize it for your selected
                    project.
                  </p>
                </div>

                <button
                  type="button"
                  className="ai-launch-btn"
                  onClick={() => {
                    clearMessages();
                    setAiOpen(true);
                  }}
                  disabled={!selectedOrgId || !selectedProjectId}
                >
                  <span>✦</span>
                  Create with AI
                </button>
              </div>

              <button
                type="button"
                className="ai-modal-close"
                onClick={closeAiModal}
                disabled={aiLoading || busy}
              >
                ×
              </button>
            </div>

            {/* STEPS */}

            <div className="ai-steps">
              <div className={`ai-step ${!aiTask ? "active" : "complete"}`}>
                <span>1</span>
                <div>
                  <strong>Describe</strong>
                  <small>Tell us what you need</small>
                </div>
              </div>

              <div className="ai-step-line" />

              <div className={`ai-step ${aiTask ? "active" : ""}`}>
                <span>{aiTask ? "✓" : "2"}</span>
                <div>
                  <strong>Review</strong>
                  <small>Check the AI result</small>
                </div>
              </div>
            </div>

            {/* CONTENT */}

            <div className="ai-modal-body">
              {/* ERROR */}

              {error && (
                <div className="ai-inline-alert error">
                  <span>!</span>

                  <div>
                    <strong>Something needs attention</strong>

                    <p>{error}</p>
                  </div>
                </div>
              )}

              {/* SUCCESS */}

              {success && (
                <div className="ai-inline-alert success">
                  <span>✓</span>

                  <div>
                    <strong>AI is ready</strong>

                    <p>{success}</p>
                  </div>
                </div>
              )}

              {/* =========================================
                  CONTEXT
                  ========================================= */}

              <div className="ai-section">
                <div className="ai-section-heading">
                  <span className="ai-section-number">01</span>

                  <div>
                    <h3>Where should this task live?</h3>

                    <p>Choose the organization and project for this work.</p>
                  </div>
                </div>

                <div className="ai-fields-grid">
                  <div className="ai-field">
                    <label>Organization</label>

                    <SelectField
                      value={selectedOrgId}
                      onChange={handleOrganizationChange}
                      disabled={aiLoading || busy}
                      placeholder="Select organization"
                      aria-label="Organization"
                      options={orgs.map((org) => ({ value: org.id, label: org.name }))}
                    />
                  </div>

                  <div className="ai-field">
                    <label>Project</label>

                    <SelectField
                      value={selectedProjectId}
                      onChange={handleProjectChange}
                      disabled={!selectedOrgId || aiLoading || busy}
                      placeholder={
                        !selectedOrgId
                          ? "Select organization first"
                          : projects.length === 0
                            ? "No projects available"
                            : "Select project"
                      }
                      aria-label="Project"
                      options={projects.map((project) => ({ value: project.id, label: project.name }))}
                    />
                  </div>
                </div>

                {/* SELECTED PROJECT */}

                {selectedProjectId && getSelectedProject() && (
                  <div className="selected-context">
                    <span className="selected-context-icon">◈</span>

                    <div>
                      <small>Creating in</small>

                      <strong>{getSelectedProject()?.name}</strong>
                    </div>

                    <span className="context-check">✓</span>
                  </div>
                )}

                {/* ASSIGNEE */}

                <div className="ai-field ai-assignee-field">
                  <label>
                    Assignee
                    <span>Optional</span>
                  </label>

                  <SelectField
                    value={selectedAssigneeId}
                    onChange={handleAssigneeChange}
                    disabled={!selectedProjectId || aiLoading || busy}
                    placeholder="Leave unassigned"
                    aria-label="Assignee"
                    options={members.map((member) => {
                      const memberId = getMemberId(member);
                      return {
                        value: memberId,
                        label: member.name || member.user_name || member.email || `User ${memberId}`,
                      };
                    })}
                  />
                </div>
              </div>

              {/* =========================================
                  PROMPT
                  ========================================= */}

              {!aiTask && (
                <div className="ai-section prompt-section">
                  <div className="ai-section-heading">
                    <span className="ai-section-number">02</span>

                    <div>
                      <h3>What do you want to accomplish?</h3>

                      <p>
                        Write naturally. You don't need to know the perfect
                        title or format.
                      </p>
                    </div>
                  </div>

                  <div className="ai-prompt-box">
                    <div className="ai-prompt-top">
                      <span className="ai-prompt-sparkle">✦</span>

                      <span>Describe your idea</span>

                      <span className="ai-prompt-hint">AI assisted</span>
                    </div>

                    <textarea
                      value={aiMessage}
                      onChange={(e) => {
                        setAiMessage(e.target.value);

                        if (error) {
                          setError("");
                        }

                        if (success) {
                          setSuccess("");
                        }
                      }}
                      placeholder={
                        selectedProjectId
                          ? "Example: Fix the login authentication issue so organization users can sign in correctly. The error happens after submitting the login form."
                          : "Select a project first, then describe what needs to be done..."
                      }
                      disabled={!selectedProjectId || aiLoading || busy}
                      autoFocus
                    />

                    <div className="ai-prompt-footer">
                      <span>
                        {aiMessage.length}
                        {" / 2000"}
                      </span>

                      <span>Be specific for a better result</span>
                    </div>
                  </div>

                  <div className="ai-examples">
                    <span>Try:</span>

                    <button
                      type="button"
                      onClick={() =>
                        setAiMessage(
                          "Fix the login authentication issue so users can sign in correctly and receive a clear error message when their credentials are invalid.",
                        )
                      }
                      disabled={!selectedProjectId || aiLoading || busy}
                    >
                      Fix a bug
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setAiMessage(
                          "Create a responsive dashboard layout that works well on desktop, tablet, and mobile screens.",
                        )
                      }
                      disabled={!selectedProjectId || aiLoading || busy}
                    >
                      Build a feature
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setAiMessage(
                          "Improve the task page so users can quickly understand task status, priority, assignee, and project.",
                        )
                      }
                      disabled={!selectedProjectId || aiLoading || busy}
                    >
                      Improve UX
                    </button>
                  </div>
                </div>
              )}

              {/* =========================================
                  ANALYZING
                  ========================================= */}

              {aiLoading && (
                <div className="ai-thinking">
                  <div className="ai-thinking-icon">
                    <span>✦</span>
                  </div>

                  <div>
                    <strong>AI is reviewing your request</strong>

                    <p>
                      Checking the project context and turning your idea into a
                      structured task...
                    </p>
                  </div>

                  <div className="ai-thinking-dots">
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              )}

              {/* =========================================
                  AI RESULT
                  ========================================= */}

              {aiTask && !aiLoading && (
                <div className="ai-section ai-review-section">
                  <div className="ai-section-heading">
                    <span className="ai-section-number">02</span>

                    <div>
                      <h3>Review your task</h3>

                      <p>
                        AI created a structured version of your request. Make
                        any changes before creating it.
                      </p>
                    </div>
                  </div>

                  <div className="ai-confirmed-banner">
                    <div className="ai-confirmed-icon">✓</div>

                    <div>
                      <strong>Task verified</strong>

                      <span>
                        This request is related to the selected project.
                      </span>
                    </div>
                  </div>

                  <div className="ai-review-card">
                    <div className="ai-field">
                      <label>Task title</label>

                      <input
                        value={aiForm.title}
                        onChange={(e) =>
                          setAiForm((previous) => ({
                            ...previous,
                            title: e.target.value,
                          }))
                        }
                        disabled={busy}
                      />
                    </div>

                    <div className="ai-field">
                      <label>Description</label>

                      <textarea
                        value={aiForm.description}
                        onChange={(e) =>
                          setAiForm((previous) => ({
                            ...previous,
                            description: e.target.value,
                          }))
                        }
                        disabled={busy}
                      />
                    </div>

                    <div className="ai-fields-grid">
                      <div className="ai-field">
                        <label>Priority</label>

                        <SelectField
                          value={aiForm.priority}
                          onChange={(e) =>
                            setAiForm((previous) => ({
                              ...previous,
                              priority: e.target.value,
                            }))
                          }
                          disabled={busy}
                          aria-label="Priority"
                          options={[
                            { value: "low", label: "Low" },
                            { value: "medium", label: "Medium" },
                            { value: "high", label: "High" },
                            { value: "urgent", label: "Urgent" },
                          ]}
                        />
                      </div>

                      <div className="ai-field">
                        <label>Status</label>

                        <SelectField
                          value={aiForm.status}
                          onChange={(e) =>
                            setAiForm((previous) => ({
                              ...previous,
                              status: e.target.value,
                            }))
                          }
                          disabled={busy}
                          aria-label="Status"
                          options={aiStatusOptions.map(([value, label]) => ({ value, label }))}
                        />
                      </div>
                    </div>

                    <div className="ai-review-context">
                      <div>
                        <small>Project</small>

                        <strong>{getSelectedProject()?.name}</strong>
                      </div>

                      <div>
                        <small>Assignee</small>

                        <strong>
                          {getSelectedMember()?.name ||
                            getSelectedMember()?.user_name ||
                            getSelectedMember()?.email ||
                            "Unassigned"}
                        </strong>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* FOOTER */}

            <div className="ai-modal-footer">
              {!aiTask ? (
                <>
                  <button
                    type="button"
                    className="ai-secondary-button"
                    onClick={closeAiModal}
                    disabled={aiLoading || busy}
                  >
                    Cancel
                  </button>

                  <button
                    type="button"
                    className="ai-primary-button"
                    onClick={analyzeWithAI}
                    disabled={
                      aiLoading ||
                      busy ||
                      !selectedOrgId ||
                      !selectedProjectId ||
                      !aiMessage.trim()
                    }
                  >
                    {aiLoading ? (
                      <>
                        <span className="button-spinner" />
                        Analyzing...
                      </>
                    ) : (
                      <>
                        <span>✦</span>
                        Analyze with AI
                        <span>→</span>
                      </>
                    )}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="ai-secondary-button"
                    onClick={() => {
                      setAiTask(null);
                      setAiForm({
                        ...emptyAiForm,
                      });
                      setError("");
                      setSuccess("");
                    }}
                    disabled={busy}
                  >
                    ← Edit prompt
                  </button>

                  <button
                    type="button"
                    className="ai-primary-button"
                    onClick={createTaskFromAI}
                    disabled={
                      busy || !aiForm.title.trim() || !aiForm.description.trim()
                    }
                  >
                    {busy ? (
                      <>
                        <span className="button-spinner" />
                        Creating task...
                      </>
                    ) : (
                      <>
                        <span>✓</span>
                        Create task
                      </>
                    )}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ==================================================
          EDIT MODAL
          ================================================== */}

      {editOpen && (
        <div
          className="task-modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) {
              setEditOpen(false);
            }
          }}
        >
          <div className="task-modal">
            <div className="task-modal-header">
              <div>
                <p className="eyebrow">Task settings</p>

                <h2>Edit task</h2>
              </div>

              <button
                type="button"
                className="task-modal-close"
                onClick={() => !busy && setEditOpen(false)}
              >
                ×
              </button>
            </div>

            <form onSubmit={updateTask}>
              <div className="task-form-group">
                <label>Task title</label>

                <input
                  value={editForm.title}
                  onChange={(e) =>
                    setEditForm((previous) => ({
                      ...previous,
                      title: e.target.value,
                    }))
                  }
                  required
                  disabled={busy}
                />
              </div>

              <div className="task-form-group">
                <label>Description</label>

                <textarea
                  value={editForm.description}
                  onChange={(e) =>
                    setEditForm((previous) => ({
                      ...previous,
                      description: e.target.value,
                    }))
                  }
                  disabled={busy}
                />
              </div>

              <div className="task-form-group">
                <label>Priority</label>

                <SelectField
                  value={editForm.priority}
                  onChange={(e) =>
                    setEditForm((previous) => ({
                      ...previous,
                      priority: e.target.value,
                    }))
                  }
                  disabled={busy}
                  aria-label="Priority"
                  options={[
                    { value: "low", label: "Low" },
                    { value: "medium", label: "Medium" },
                    { value: "high", label: "High" },
                    { value: "urgent", label: "Urgent" },
                  ]}
                />
              </div>

              <div className="task-form-group">
                <label>Status</label>

                <SelectField
                  value={editForm.status}
                  onChange={(e) =>
                    setEditForm((previous) => ({
                      ...previous,
                      status: e.target.value,
                    }))
                  }
                  disabled={busy}
                  aria-label="Status"
                  options={editStatusOptions.map(([value, label]) => ({ value, label }))}
                />
              </div>

              <div className="task-modal-actions">
                <button
                  type="button"
                  className="task-cancel-btn"
                  onClick={() => !busy && setEditOpen(false)}
                  disabled={busy}
                >
                  Cancel
                </button>

                <button type="submit" className="task-save-btn" disabled={busy}>
                  {busy ? "Saving..." : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <Modal
        isOpen={statusModalOpen}
        onClose={() => setStatusModalOpen(false)}
        title="Manage statuses"
        closeDisabled={busy}
        className="ui-modal--status"
        footer={
          <>
            <Button variant="secondary" onClick={() => setStatusModalOpen(false)} disabled={busy}>Close</Button>
            <Button type="submit" form="task-status-form" loading={busy}>Save status</Button>
          </>
        }
      >
        <div className="stack-form">
          <form id="task-status-form" className="stack-form" onSubmit={saveProjectStatus}>
            <label className="ui-field">
              <span>Status name</span>
              <input
                value={statusDraft.label}
                onChange={(event) => setStatusDraft({ ...statusDraft, label: event.target.value })}
                placeholder="e.g. In review"
                required
              />
            </label>

            <label className="ui-field color-field">
              <span>Color</span>
              <span className="color-field-row">
                <input
                  type="color"
                  value={statusDraft.color || "#8b7cff"}
                  onChange={(event) => setStatusDraft({ ...statusDraft, color: event.target.value })}
                  className="color-input"
                />
                <span className="color-swatch-picker">
                  {["#8b7cff", "#6fa8ff", "#d7b66f", "#c58bff", "#59d68c", "#ef8e99", "#7d8797"].map((color) => (
                    <button
                      type="button"
                      key={color}
                      className={statusDraft.color === color ? "is-selected" : ""}
                      style={{ backgroundColor: color }}
                      onClick={() => setStatusDraft({ ...statusDraft, color })}
                      aria-label={`Use ${color}`}
                    />
                  ))}
                </span>
              </span>
            </label>
          </form>

          <div className="status-order-list">
            {statusStatusOptions.map((status, index) => (
              <div className="status-order-row" key={status.id}>
                <span className="status-dot" style={{ backgroundColor: status.color }} />
                <b>{status.label}</b>
                <div className="status-order-actions">
                  <Button variant="ghost" onClick={() => setStatusDraft({ id: status.id, label: status.label, color: status.color })} disabled={busy}>Edit</Button>
                  <Button variant="ghost" onClick={() => reorderProjectStatuses(index, -1)} disabled={busy || index === 0}>↑</Button>
                  <Button variant="ghost" onClick={() => reorderProjectStatuses(index, 1)} disabled={busy || index === statusStatusOptions.length - 1}>↓</Button>
                  <Button variant="danger" onClick={() => deleteProjectStatus(status)} disabled={busy}>Delete</Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={Boolean(confirmDeleteTarget)}
        onClose={() => !busy && setConfirmDeleteTarget(null)}
        onConfirm={confirmDeleteTask}
        title="Delete task"
        description={`Delete "${confirmDeleteTarget?.title || ""}"? This action can't be undone.`}
        confirmLabel="Delete task"
        busy={busy}
      />
    </section>
  );
}
