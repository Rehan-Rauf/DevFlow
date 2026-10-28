import { useState } from "react";
import TaskAgentPanel from "./TaskAgentPanel";
import TaskAIPanel from "./TaskAIPanel";
import "../styles/task-agent-workspace.css";

export default function TaskAgentWorkspace({
  taskId,
  task,
  projectId,
  organizationId,
  onTaskDeleted,
}) {
  const [mode, setMode] = useState("ask");

  function handleTabKeyDown(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nextMode = mode === "ask" ? "action" : "ask";
    setMode(nextMode);
    document.getElementById(
      nextMode === "ask" ? "task-assistant-ask-tab" : "task-assistant-action-tab",
    )?.focus();
  }

  if (!taskId) {
    return (
      <section className="task-agent-workspace task-agent-workspace--empty" aria-live="polite">
        <p>Choose a task to open its assistant workspace.</p>
      </section>
    );
  }

  const taskTitle = task?.title || `Task ${taskId}`;
  const projectLabel = task?.project_name || (projectId ? `Project #${projectId}` : null);

  return (
    <section className="task-agent-workspace" aria-label="Task Assistant workspace">
      <header className="task-agent-workspace__context">
        <div className="task-agent-workspace__task">
          <strong title={taskTitle}>{taskTitle}</strong>
          <span>
            {projectLabel || "Project context unavailable"}
            {organizationId ? ` · Organization #${organizationId}` : ""}
          </span>
        </div>
      </header>

      <div className="task-agent-workspace__modes" role="tablist" aria-label="Assistant mode">
        <button
          id="task-assistant-ask-tab"
          type="button"
          role="tab"
          aria-selected={mode === "ask"}
          aria-controls="task-assistant-ask-panel"
          tabIndex={mode === "ask" ? 0 : -1}
          onClick={() => setMode("ask")}
          onKeyDown={handleTabKeyDown}
        >
          <span aria-hidden="true">◌</span>
          Ask AI
          <small>Understand this task</small>
        </button>
        <button
          id="task-assistant-action-tab"
          type="button"
          role="tab"
          aria-selected={mode === "action"}
          aria-controls="task-assistant-action-panel"
          tabIndex={mode === "action" ? 0 : -1}
          onClick={() => setMode("action")}
          onKeyDown={handleTabKeyDown}
        >
          <span aria-hidden="true">✦</span>
          Take Action
          <small>Make an authorized change</small>
        </button>
      </div>

      <div
        id="task-assistant-ask-panel"
        className="task-agent-workspace__conversation"
        role="tabpanel"
        aria-labelledby="task-assistant-ask-tab"
        hidden={mode !== "ask"}
      >
        <TaskAIPanel key={taskId} taskId={taskId} />
      </div>
      <div
        id="task-assistant-action-panel"
        className="task-agent-workspace__conversation"
        role="tabpanel"
        aria-labelledby="task-assistant-action-tab"
        hidden={mode !== "action"}
      >
        <TaskAgentPanel key={taskId} taskId={taskId} onTaskDeleted={onTaskDeleted} />
      </div>
    </section>
  );
}
