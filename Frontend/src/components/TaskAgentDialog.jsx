import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../services/api";
import Modal from "./ui/Modal";
import TaskAgentWorkspace from "./TaskAgentWorkspace";

function unwrap(response) {
  return response?.data?.data ?? response?.data ?? response;
}

function listFrom(response) {
  const data = unwrap(response);
  return Array.isArray(data) ? data : [];
}

function taskFrom(response) {
  const data = unwrap(response);
  return data?.task || data;
}

function taskLabel(task) {
  return `TASK-${task.id} · ${task.title || "Untitled task"}`;
}

export default function TaskAgentDialog({ open, scope, onClose, onTaskDeleted }) {
  const [tasks, setTasks] = useState([]);
  const [tasksScope, setTasksScope] = useState("");
  const [selectedTask, setSelectedTask] = useState(null);
  const [selectedTaskScope, setSelectedTaskScope] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retryCount, setRetryCount] = useState(0);
  const selectionRequest = useRef(0);

  const scopeKey = useMemo(
    () => `${scope?.entityType || "workspace"}:${scope?.entityId || ""}`,
    [scope?.entityId, scope?.entityType],
  );

  useEffect(() => {
    if (!open) return undefined;

    let cancelled = false;
    setTasks([]);
    setTasksScope("");
    setSelectedTask(null);
    setSelectedTaskScope("");
    setSelectedId("");
    setError("");
    setLoading(true);

    async function loadScope() {
      try {
        if (scope?.entityType === "task" && scope.entityId) {
          const task = taskFrom(await api.getTask(scope.entityId));
          if (!task?.id || String(task.id) !== String(scope.entityId)) {
            throw new Error("The selected task could not be loaded.");
          }
          if (!cancelled) {
            setSelectedTask(task);
            setSelectedTaskScope(scopeKey);
            setSelectedId(String(task.id));
          }
          return;
        }

        let taskRows;
        if (scope?.entityType === "project" && scope.entityId) {
          taskRows = listFrom(await api.tasks(scope.entityId));
        } else if (scope?.entityType === "organization" && scope.entityId) {
          const projects = listFrom(await api.projects(scope.entityId));
          const projectTasks = await Promise.all(
            projects.map((project) => api.tasks(project.id).then(listFrom)),
          );
          taskRows = projectTasks.flat();
        } else {
          taskRows = listFrom(await api.getMyTasks());
        }

        if (cancelled) return;
        setTasks(taskRows);
        setTasksScope(scopeKey);
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError.message || "Unable to load available tasks.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadScope();
    return () => {
      cancelled = true;
      selectionRequest.current += 1;
    };
  }, [open, scopeKey, retryCount]);

  async function selectTask(event) {
    const nextId = event.target.value;
    setSelectedId(nextId);
    setSelectedTask(null);
    setSelectedTaskScope("");
    setError("");
    const requestId = ++selectionRequest.current;
    if (!nextId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const task = taskFrom(await api.getTask(nextId));
      if (!task?.id || String(task.id) !== String(nextId)) {
        throw new Error("The selected task could not be loaded.");
      }
      if (scope?.entityType === "project" && String(task.project_id) !== String(scope.entityId)) {
        throw new Error("The selected task does not belong to this project.");
      }
      if (scope?.entityType === "organization" && String(task.organization_id) !== String(scope.entityId)) {
        throw new Error("The selected task does not belong to this organization.");
      }
      if (requestId === selectionRequest.current) {
        setSelectedTask(task);
        setSelectedTaskScope(scopeKey);
      }
    } catch (requestError) {
      if (requestId === selectionRequest.current) {
        setError(requestError.message || "Unable to open this task.");
      }
    } finally {
      if (requestId === selectionRequest.current) setLoading(false);
    }
  }

  function retry() {
    setError("");
    setSelectedTask(null);
    setSelectedId("");
    setTasks([]);
    setTasksScope("");
    setRetryCount((current) => current + 1);
  }

  function closeAssistant() {
    setSelectedTask(null);
    setSelectedTaskScope("");
    onClose?.();
  }

  function handleTaskDeleted() {
    setSelectedTask(null);
    setSelectedTaskScope("");
    (onTaskDeleted || closeAssistant)();
  }

  const needsSelection = scope?.entityType !== "task" || !scope.entityId;
  const emptyMessage = scope?.entityType === "project"
    ? "This project has no tasks available to you yet."
    : scope?.entityType === "organization"
      ? "This organization has no tasks available to you yet."
      : "No tasks are available to you yet.";

  return (
    <Modal
      isOpen={open}
      onClose={closeAssistant}
      title="Task Assistant"
      className="task-agent-dialog"
    >
      {loading && !selectedTask && (
        <p className="task-agent-dialog__status" role="status">Loading authorized tasks…</p>
      )}

      {error && (
        <div className="task-agent-dialog__error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={retry}>Retry</button>
        </div>
      )}

      {!loading && !error && needsSelection && tasksScope === scopeKey && (
        tasks.length ? (
          <label className="ui-field task-agent-dialog__selector">
            <span>{scope?.entityType === "project" ? "Choose a task in this project" : scope?.entityType === "organization" ? "Choose a task in this organization" : "Choose a task"}</span>
            <select value={selectedId} onChange={selectTask}>
              <option value="">Select a task</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>{taskLabel(task)}</option>
              ))}
            </select>
          </label>
        ) : (
          <p className="task-agent-dialog__status">{emptyMessage}</p>
        )
      )}

      {selectedTask && selectedTaskScope === scopeKey && !loading && (
        <TaskAgentWorkspace
          taskId={selectedTask.id}
          task={selectedTask}
          projectId={selectedTask.project_id}
          organizationId={selectedTask.organization_id}
          onTaskDeleted={handleTaskDeleted}
        />
      )}
    </Modal>
  );
}
