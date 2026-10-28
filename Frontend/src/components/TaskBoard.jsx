import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { formatTaskPriority } from "../utils/taskFormatters";

/**
 * Reusable board driven by project status records. The all-work view infers
 * its metadata from returned task records instead of a fixed workflow list.
 */
export default function TaskBoard({
  tasks,
  statuses = [],
  draggingId,
  dragOverStatus,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  renderTaskActions,
  onAddTask,
  showProject = false,
  emptyMessage = "Drop tasks here",
  fixedHeight = true,
  boardHeaderActions = null,
}) {
  const frameRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const workflow = statuses.length
    ? statuses
    : [...new Map(tasks.map((task) => [task.status, {
      key: task.status,
      label: task.status_label || String(task.status || "Uncategorized").replaceAll("_", " "),
      color: task.status_color || "#8b7cff",
      position: Number(task.status_position || 0),
    }])).values()].sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;

    const board = frame.querySelector(".kanban");

    const updateScrollState = () => {
      const maxScrollLeft = frame.scrollWidth - frame.clientWidth;
      setCanScrollLeft(frame.scrollLeft > 1);
      setCanScrollRight(maxScrollLeft - frame.scrollLeft > 1);
    };

    updateScrollState();
    frame.addEventListener("scroll", updateScrollState, { passive: true });
    const resizeObserver = new ResizeObserver(updateScrollState);
    resizeObserver.observe(frame);
    if (board) resizeObserver.observe(board);

    return () => {
      frame.removeEventListener("scroll", updateScrollState);
      resizeObserver.disconnect();
    };
  }, [workflow.length, tasks.length]);

  if (!workflow.length) return <div className="kanban-empty">No workflow statuses are available yet.</div>;

  const scrollKanban = (direction = 1) => {
    const frame = frameRef.current;
    if (!frame) return;

    const maxScrollLeft = frame.scrollWidth - frame.clientWidth;
    const step = Math.max(210, Math.min(320, frame.clientWidth * 0.75));
    const nextScrollLeft = Math.max(
      0,
      Math.min(maxScrollLeft, frame.scrollLeft + direction * step)
    );

    frame.scrollTo({ left: nextScrollLeft, behavior: "smooth" });
  };

  return (
    <div className={`kanban-scroll-shell${fixedHeight ? " kanban-scroll-shell--fixed" : ""}${workflow.length === 1 ? " kanban-scroll-shell--single" : ""}`}>
      {boardHeaderActions && (
        <div className="kanban-board-actions">
          {boardHeaderActions}
        </div>
      )}
      <div className="kanban-scroll-stage">
        <button
          type="button"
          className="kanban-scroll-button kanban-scroll-button-left"
          aria-label="Scroll workflow left"
          aria-disabled={!canScrollLeft}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (canScrollLeft) scrollKanban(-1);
          }}
        >‹</button>
        <div ref={frameRef} className="kanban-scroll-frame">
          <div className="kanban" aria-label="Task workflow board">
            {workflow.map((status) => {
              const statusKey = status.key || status.id;
              const columnTasks = tasks.filter((task) => task.status === statusKey);

              return (
                <section
                  key={status.id || statusKey}
                  className={`kanban-column ${dragOverStatus === statusKey ? "drag-over" : ""}`}
                  style={{ "--status-color": status.color || "#8b7cff" }}
                  onDragOver={(event) => onDragOver?.(event, statusKey)}
                  onDragLeave={(event) => onDragLeave?.(event, statusKey)}
                  onDrop={(event) => onDrop?.(event, statusKey)}
                >
                  <header className="column-title">
                    <span className="column-title-left">
                      <span className="status-dot" />
                      <b>{status.label}</b>
                    </span>
                    <span className="column-title-actions">
                      {onAddTask && (
                        <button
                          type="button"
                          className="kanban-add-task"
                          aria-label={`Add task to ${status.label}`}
                          title={`Add task to ${status.label}`}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onAddTask(statusKey);
                          }}
                        >
                          +
                        </button>
                      )}
                      <span className="column-count">{columnTasks.length}</span>
                    </span>
                  </header>

                  <div className="kanban-column-body">
                    {columnTasks.map((task) => (
                      <article key={task.id} className={`task-card-wrapper ${draggingId === task.id ? "is-dragging" : ""}`}>
                        <Link to={`/tasks/${task.id}`} draggable className="task-card" onDragStart={(event) => onDragStart?.(event, task.id)} onDragEnd={onDragEnd}>
                          <div className="task-card-top">
                            <span className="task-id">TASK-{task.id}</span>
                            <span className={`priority-badge ${task.priority || "no_priority"}`}>{formatTaskPriority(task.priority)}</span>
                          </div>
                          <h3>{task.title}</h3>
                          <p>{task.description || "No description provided."}</p>
                          <div className="task-card-footer">
                            <span className="task-assignee">{task.assignee_name || "Unassigned"}</span>
                            {task.role_tag_label && <span className="role-tag-badge">{task.role_tag_label}</span>}
                            {showProject && <span className="task-project">{task.project_name || "No project"}</span>}
                          </div>
                        </Link>
                        {renderTaskActions?.(task)}
                      </article>
                    ))}

                    {columnTasks.length === 0 && (
                      <div className="kanban-empty">
                        {onAddTask ? (
                          <button
                            type="button"
                            className="kanban-empty-icon"
                            aria-label={`Add task to ${status.label}`}
                            title={`Add task to ${status.label}`}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              onAddTask(statusKey);
                            }}
                          >
                            +
                          </button>
                        ) : (
                          <div className="kanban-empty-icon">+</div>
                        )}
                        <span>{emptyMessage}</span>
                      </div>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
        <button
          type="button"
          className="kanban-scroll-button kanban-scroll-button-right"
          aria-label="Scroll workflow right"
          aria-disabled={!canScrollRight}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (canScrollRight) scrollKanban(1);
          }}
        >›</button>
      </div>
    </div>
  );
}
