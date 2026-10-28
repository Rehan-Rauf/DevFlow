import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Button from "./ui/Button";
import ConfirmDialog from "./ui/ConfirmDialog";
import AIMemoryPanel from "./AIMemoryPanel";
import aiService from "../services/aiService";

const ACTION_SUGGESTIONS = [
  "Change this task's status to Done",
  "Set this task's priority to High",
  "Show the other tasks in this project",
];

const CHANGE_LABELS = {
  title: "Title",
  description: "Description",
  status: "Status",
  priority: "Priority",
  due_date: "Due date",
  assignee_id: "Assignee ID",
};

function shownValue(value) {
  if (value === null || value === undefined || value === "") return "None";
  return String(value);
}

function AgentMessage({ role, content, memoriesUsed = 0, changes = [] }) {
  return (
    <div className={`task-agent-message task-agent-message--${role}`}>
      <span className="task-agent-message__label">
        {role === "user" ? "You" : "Agent"}
      </span>

      <div className="task-agent-message__bubble">
        {role === "user" ? content : (
          <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
            {content}
          </ReactMarkdown>
        )}
      </div>
      {role === "agent" && changes.map((change, index) => (
        <div className="task-agent-change" key={`${change.type}-${change.task?.id}-${index}`}>
          <strong>
            {change.type === "created" ? "Created task" : "Updated task"}
            {change.task?.title ? ` · ${change.task.title}` : ""}
          </strong>
          {change.type === "updated" && Object.entries(change.after || {}).map(([field, value]) => (
            <span key={field}>
              <b>{CHANGE_LABELS[field] || field}:</b>{" "}
              {shownValue(change.before?.[field])} <span aria-hidden="true">→</span> {shownValue(value)}
            </span>
          ))}
        </div>
      ))}
      {role === "agent" && memoriesUsed > 0 && (
        <div className="ai-memory-used">Memory used · {memoriesUsed}</div>
      )}
    </div>
  );
}

/**
 * Task-scoped AI Agent.
 *
 * The user communicates only through natural-language prompts.
 * The backend Agent decides which authorized tool to use.
 */
export default function TaskAgentPanel({ taskId, onTaskDeleted }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pendingConfirmation, setPendingConfirmation] = useState(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [retryMessage, setRetryMessage] = useState("");

  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading, pendingConfirmation]);

  async function askAgent(message, confirmationToken = null, confirmationAction = null, isRetry = false) {
    const trimmed = message.trim();

    if (!trimmed || loading) {
      return;
    }

    setError("");

    // Add the user's normal message to the conversation.
    if (!confirmationToken) {
      if (!isRetry) {
        setMessages((current) => [
          ...current,
          {
            role: "user",
            content: trimmed,
          },
        ]);
      }
      setInput("");
    }

    setLoading(true);

    try {
      const response = await aiService.taskAgent(
        taskId,
        trimmed,
        confirmationToken,
        confirmationAction,
      );

      const data = response.data || {};

      const answer =
        data.answer ||
        "The agent could not complete that request.";

      setRetryMessage("");
      setMessages((current) => [
        ...current,
        {
          role: "agent",
          content: answer,
          memoriesUsed: data.memoriesUsed || 0,
          changes: data.changes || [],
        },
      ]);

      for (const change of data.changes || []) {
        if (change.type === "created") {
          window.dispatchEvent(new CustomEvent("devflow:task-created", {
            detail: {
              taskId: change.task?.id,
              projectId: change.task?.project_id,
            },
          }));
        }
      }

      /*
       * Delete requires backend confirmation.
       */
      if (
        data.requiresConfirmation &&
        data.confirmationToken
      ) {
        setPendingConfirmation({
          message: trimmed,
          token: data.confirmationToken,
          action: data.confirmationAction,
        });
      } else {
        setPendingConfirmation(null);
      }

      /*
       * Only navigate when backend confirms the task
       * was actually deleted.
       */
      if (data.deleted) {
        onTaskDeleted?.();
      }
    } catch (requestError) {
      if (!confirmationToken) {
        setRetryMessage(trimmed);
        setInput(trimmed);
      }
      setError(
        requestError.message ||
          "The task agent is unavailable right now.",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(event) {
    event.preventDefault();

    if (!input.trim()) {
      return;
    }

    askAgent(input);
  }

  /*
   * Optional convenience:
   * Enter = send
   * Shift + Enter = new line
   */
  function handleKeyDown(event) {
    if (
      event.key === "Enter" &&
      !event.shiftKey
    ) {
      event.preventDefault();

      if (
        input.trim() &&
        !loading &&
        !pendingConfirmation
      ) {
        askAgent(input);
      }
    }
  }

  return (
    <section
      className="task-agent-panel section-card"
      aria-labelledby="task-agent-title"
    >
      <header className="task-agent-panel__header">
        <div>
          <p className="eyebrow">Take Action</p>

          <p>
            Describe a change or ask to inspect this project.
          </p>
        </div>

        <span
          className="task-agent-panel__mark"
          aria-hidden="true"
        >
          ✦
        </span>
        <Button type="button" variant="secondary" onClick={() => setMemoryOpen(true)}>
          Memory
        </Button>
      </header>

      <div
        className="task-agent-panel__messages"
        ref={scrollRef}
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <div className="task-agent-panel__empty">
            <strong>What would you like to change?</strong>
            <p>Actions run through your authorized project access. Deletions always need confirmation.</p>
            <div className="task-agent-panel__suggestions">
              {ACTION_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="task-agent-panel__suggestion"
                  onClick={() => askAgent(suggestion)}
                  disabled={loading || Boolean(pendingConfirmation)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message, index) => (
            <AgentMessage
              key={`${message.role}-${index}`}
              {...message}
            />
          ))
        )}

        {loading && (
          <div className="task-agent-activity">
            <span aria-hidden="true">◌</span>
            Agent is working…
          </div>
        )}
      </div>

      {error && (
        <div
          className="task-agent-panel__error"
          role="alert"
        >
          <span>{error}</span>
          {retryMessage && (
            <button
              type="button"
              onClick={() => askAgent(retryMessage, null, null, true)}
              disabled={loading}
            >
              Retry request
            </button>
          )}
        </div>
      )}

      {pendingConfirmation && (
        <ConfirmDialog
          isOpen={Boolean(pendingConfirmation)}
          onClose={() => !loading && setPendingConfirmation(null)}
          onConfirm={() =>
            askAgent(
              pendingConfirmation.message,
              pendingConfirmation.token,
              pendingConfirmation.action,
            )
          }
          title="Delete task"
          description="The agent will delete this task after you confirm. This action can't be undone."
          confirmLabel="Delete task"
          busy={loading}
        />
      )}

      <form
        className="task-agent-panel__input"
        onSubmit={handleSubmit}
      >
        <label
          className="sr-only"
          htmlFor={`task-agent-input-${taskId}`}
        >
          Ask the task agent
        </label>

        <textarea
          id={`task-agent-input-${taskId}`}
          value={input}
          onChange={(event) =>
            setInput(event.target.value)
          }
          onKeyDown={handleKeyDown}
          placeholder="Tell the agent what you want to do…"
          rows="3"
          disabled={
            loading ||
            Boolean(pendingConfirmation)
          }
        />

        <Button
          type="submit"
          disabled={
            !input.trim() ||
            Boolean(pendingConfirmation)
          }
          loading={loading}
        >
          Send
        </Button>
      </form>
      <AIMemoryPanel isOpen={memoryOpen} onClose={() => setMemoryOpen(false)} scope={{ taskId }} title="Task Memory" />
    </section>
  );
}