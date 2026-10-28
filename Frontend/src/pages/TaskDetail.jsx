import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../services/api";
import { io } from "socket.io-client";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import "../styles/task-detail.css";

function formatStatus(value) {
  return (value || "todo")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatPriority(value) {
  return (value || "no_priority")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

export default function TaskDetail() {
  const { id } = useParams();
  const [task, setTask] = useState(null);
  const [comments, setComments] = useState([]);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState(null);
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);

  async function load() {
    try {
      setError("");

      const [taskResponse, commentsResponse] = await Promise.all([
        api.getTask(id),
        api.comments(id),
      ]);

      setTask(taskResponse.data || taskResponse);
      setComments(commentsResponse.data || []);
    } catch (e) {
      setError(e.message || "Unable to load task.");
    }
  }

  useEffect(() => {
    load();

    const token = localStorage.getItem("cms_token");

    const socket = io(
      import.meta.env.VITE_SOCKET_URL || "http://localhost:5001",
      { auth: { token } },
    );

    socket.emit("join_task", id);

    socket.on("comment_added", (comment) => {
      setComments((current) =>
        current.some((item) => item.id === comment.id)
          ? current
          : [...current, comment],
      );
    });

    socket.on("comment_deleted", (commentId) => {
      setComments((current) => current.filter((item) => item.id !== commentId));
    });

    socket.on("task_changed", load);
    socket.on("task_room_error", (roomError) => {
      setError(roomError.message || "Unable to subscribe to task updates.");
    });

    return () => {
      socket.emit("leave_task", id);
      socket.disconnect();
    };
  }, [id]);

  async function sendComment(event) {
    event.preventDefault();

    if (!text.trim()) return;

    try {
      await api.addComment(id, {
        content: text.trim(),
        parentId: replyTo,
      });

      setText("");
      setReplyTo(null);
    } catch (e) {
      setError(e.message || "Unable to add comment.");
    }
  }

  async function deleteComment() {
    if (!deleteTarget) return;
    try {
      await api.deleteComment(deleteTarget.id);
      setDeleteTarget(null);
    } catch (e) {
      setError(e.message || "Unable to delete comment.");
    }
  }

  const rootComments = comments.filter((comment) => !comment.parent_id);

  function replies(parentId) {
    return comments.filter(
      (comment) => String(comment.parent_id) === String(parentId),
    );
  }

  function renderComment(comment) {
    return (
      <div className="comment" key={comment.id}>
        <div className="comment-avatar">
          {comment.user_name?.[0]?.toUpperCase() || "U"}
        </div>

        <div className="comment-body">
          <div className="comment-head">
            <b>{comment.user_name}</b>
            <span>{formatDate(comment.created_at)}</span>
          </div>

          <p>{comment.content}</p>

          <div className="comment-actions">
            <button type="button" onClick={() => setReplyTo(comment.id)}>
              Reply
            </button>

            {task?.is_org_admin && (
              <button type="button" onClick={() => setDeleteTarget(comment)}>
                Delete
              </button>
            )}
          </div>

          {replies(comment.id).map(renderComment)}
        </div>
      </div>
    );
  }

  if (error && !task) {
    return (
      <section className="page">
        <div className="error-box">{error}</div>
      </section>
    );
  }

  if (!task) {
    return (
      <section className="page">
        <div className="empty-state">Loading task…</div>
      </section>
    );
  }

  const statusColor = task.status_color || "#8b7cff";

  return (
    <section className="page task-page">
      <nav className="task-detail-breadcrumb" aria-label="Task breadcrumbs">
        <Link to="/tasks">Tasks</Link>
        <span aria-hidden="true">/</span>
        <Link to={`/projects/${task.project_id}`}>{task.project_name || "Project"}</Link>
        <span aria-hidden="true">/</span>
        <span className="task-detail-breadcrumb__id">TASK-{task.id}</span>
      </nav>

      <div className="detail-grid">
        <div className="detail-main">
          <div className="task-hero">
            <div className="task-hero-main">
              <div className="task-heading-meta">
                <span className="task-state-pill" style={{ color: statusColor, borderColor: statusColor, backgroundColor: `${statusColor}18` }}>
                  <span className="task-state-dot" />
                  {task.status_label || formatStatus(task.status)}
                </span>

                {task.role_tag_label && <span className="role-tag-badge">{task.role_tag_label}</span>}
              </div>

              <h1>{task.title}</h1>
              <p className="muted">{task.description || "No description"}</p>
            </div>
          </div>
        </div>

        <aside className="detail-side">
          <div className="section-card task-details-card">
            <p className="eyebrow">Details</p>

            <div className="side-row">
              <span>Organization</span>
              <b>{task.organization_name}</b>
            </div>

            <div className="side-row">
              <span>Project</span>
              <b>{task.project_name}</b>
            </div>

            <div className="side-row">
              <span>Assignee</span>
              <b>{task.assignee_name || "Unassigned"}</b>
            </div>

            <div className="side-row">
              <span>Created by</span>
              <b>{task.creator_name}</b>
            </div>

            <div className="side-row">
              <span>Due date</span>
              <b>{task.due_date || "No due date"}</b>
            </div>

            <div className="side-row">
              <span>Status</span>
              <b>{task.status_label || formatStatus(task.status)}</b>
            </div>

            <div className="side-row">
              <span>Priority</span>
              <b>{formatPriority(task.priority)}</b>
            </div>

            <div className="side-row">
              <span>Role tag</span>
              <b>{task.role_tag_label || "None"}</b>
            </div>
          </div>

          <button
            type="button"
            className="task-agent-open-button"
            onClick={() => window.dispatchEvent(new CustomEvent("devflow:open-task-agent", {
              detail: { entityType: "task", entityId: Number(task.id) },
            }))}
          >
            <span aria-hidden="true">✦</span>
            Open Task Agent
          </button>
        </aside>

        <div className="detail-conversation">
          <div className="section-card task-comments-card">
            <div className="section-header">
              <div>
                <p className="eyebrow">Conversation</p>
                <h2>Comments</h2>
              </div>

              <span className="count-badge">{comments.length}</span>
            </div>

            {rootComments.map(renderComment)}

            {!comments.length && (
              <div className="kanban-empty">
                No comments yet. Start the conversation.
              </div>
            )}

            <form className="comment-form" onSubmit={sendComment}>
              {replyTo && (
                <div className="replying">
                  Replying to comment
                  <button type="button" onClick={() => setReplyTo(null)}>
                    Cancel
                  </button>
                </div>
              )}

              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={replyTo ? "Write a reply…" : "Write a comment…"}
                rows="3"
              />

              <button className="btn btn-primary" type="submit">
                {replyTo ? "Reply" : "Comment"}
              </button>
            </form>
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={deleteComment}
        title="Delete comment"
        description="Delete this comment and any replies beneath it? This action can't be undone."
        confirmLabel="Delete comment"
      />
    </section>
  );
}
