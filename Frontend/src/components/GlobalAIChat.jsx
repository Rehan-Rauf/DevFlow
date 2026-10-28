import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../services/api";
import ConfirmDialog from "./ui/ConfirmDialog";
import AIMemoryPanel from "./AIMemoryPanel";
import "../styles/ai-global.css";

const SUGGESTIONS = [
  "What are my active tasks?",
  "Summarize my projects",
  "What is currently blocking me?",
  "What should I work on next?",
];

function SourceChip({ source }) {
  const label =
    source.label ||
    `${source.type}${source.id ? ` #${source.id}` : ""}`;
  const targetPath = source.type === "task" ? `/tasks/${source.id}`
    : source.type === "project" ? `/projects/${source.id}`
      : source.type === "organization" ? `/organizations/${source.id}`
        : null;

  return targetPath
    ? <Link className="ai-source-chip ai-source-link" to={targetPath}>{label}</Link>
    : <span className="ai-source-chip">{label}</span>;
}

function Message({ message }) {
  const isUser = message.role === "user";

  return (
    <div
      className={`ai-message ${
        isUser
          ? "ai-message-user"
          : "ai-message-assistant"
      }`}
    >
      <div className="ai-message-bubble">
        {isUser
          ? message.content
          : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{
                a: ({ href, children, ...props }) => {
                  const external = /^https?:\/\//i.test(href || "");
                  return (
                    <a
                      href={href}
                      {...props}
                      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    >
                      {children}
                    </a>
                  );
                },
              }}
            >
              {message.content}
            </ReactMarkdown>
          )}
      </div>

      {!isUser &&
        Array.isArray(message.sources) &&
        message.sources.length > 0 && (
          <div className="ai-sources">
            <span className="ai-sources-label">
              Sources
            </span>

            {message.sources.map((s, i) => (
              <SourceChip
                key={i}
                source={s}
              />
            ))}
          </div>
        )}
      {!isUser && message.memoriesUsed > 0 && (
        <div className="ai-sources ai-memory-used">
          Memory used · {message.memoriesUsed}
        </div>
      )}
    </div>
  );
}

const PROPOSAL_STATUS_LABELS = {
  proposed: "Awaiting approval",
  approved: "Approved",
  executing: "Executing",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
};

function ActionProposalCard({ proposal, busy, onApprove, onCancel }) {
  const targetParts = [
    proposal.target?.organizationName,
    proposal.target?.projectName,
    proposal.target?.taskName,
  ].filter(Boolean);
  const canApprove = ["proposed", "approved"].includes(proposal.status);
  const canCancel = canApprove;

  return (
    <article className={`ai-action-card ai-action-card--${proposal.status}`} aria-label="AI action proposal">
      <div className="ai-action-card__heading">
        <strong>Review AI action</strong>
        <span role="status">{PROPOSAL_STATUS_LABELS[proposal.status] || proposal.status}</span>
      </div>
      <p className="ai-action-card__summary">{proposal.summary}</p>
      {targetParts.length > 0 && (
        <p className="ai-action-card__target" aria-label="Action target">
          {targetParts.join(" → ")}
        </p>
      )}
      <details className="ai-action-card__details">
        <summary>Inspect proposed fields</summary>
        {proposal.changes?.before && (
          <pre><strong>Before</strong>{"\n"}{JSON.stringify(proposal.changes.before, null, 2)}</pre>
        )}
        {proposal.changes?.after && (
          <pre><strong>Proposed</strong>{"\n"}{JSON.stringify(proposal.changes.after, null, 2)}</pre>
        )}
        <small>Expires {new Date(proposal.expiresAt).toLocaleString()}</small>
      </details>
      {proposal.status === "succeeded" && proposal.result?.resource && (
        <p className="ai-action-card__result">
          Saved: {proposal.result.resource.title || proposal.result.resource.name}
        </p>
      )}
      {proposal.status === "failed" && (
        <p className="ai-action-card__error" role="alert">
          {proposal.error || "The action failed. No success was reported."}
        </p>
      )}
      {proposal.status === "cancelled" && <p className="ai-action-card__result">No changes were made.</p>}
      {proposal.status === "expired" && <p className="ai-action-card__error">This proposal expired. Ask the agent to prepare it again.</p>}
      {(canApprove || canCancel) && (
        <div className="ai-action-card__actions">
          {canCancel && (
            <button type="button" className="btn btn-secondary" onClick={() => onCancel(proposal)} disabled={busy}>
              Cancel
            </button>
          )}
          {canApprove && (
            <button type="button" className="btn btn-primary" onClick={() => onApprove(proposal)} disabled={busy}>
              {busy ? "Checking..." : "Approve"}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

export default function GlobalAIChat({
  open,
  onClose,
  sessionId = null,
  context = null,
}) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] =
    useState(false);
  const [error, setError] = useState("");
  const [endingChat, setEndingChat] =
    useState(false);
  const [viewingHistory, setViewingHistory] = useState(false);
  const [historyStatus, setHistoryStatus] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [recentChats, setRecentChats] = useState([]);
  const [actionProposals, setActionProposals] = useState([]);
  const [busyProposalIds, setBusyProposalIds] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [confirmDeleteChat, setConfirmDeleteChat] = useState(null);
  const [deletingChat, setDeletingChat] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);
  const [closingAll, setClosingAll] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [contextLabel, setContextLabel] = useState("Your authorized workspaces");
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [lastFailedMessage, setLastFailedMessage] = useState("");

  const scrollRef = useRef(null);
  const nearLatestRef = useRef(true);
  const previousMessageCountRef = useRef(0);
  const activeSessionId = selectedSessionId || sessionId;

  useEffect(() => {
    if (!open || !context?.entityType || !context?.entityId) {
      setContextLabel("Your authorized workspaces");
      return undefined;
    }

    let cancelled = false;
    async function loadContextLabel() {
      const fallback = `${context.entityType[0].toUpperCase()}${context.entityType.slice(1)} #${context.entityId}`;
      setContextLabel(fallback);
      try {
        let response;
        if (context.entityType === "task") response = await api.getTask(context.entityId);
        else if (context.entityType === "project") response = await api.getProject(context.entityId);
        else if (context.entityType === "organization") response = await api.getOrganization(context.entityId);
        else return;

        const entity = response.data || response;
        const nextLabel = context.entityType === "task"
          ? [entity.organization_name, entity.project_name, entity.title].filter(Boolean).join(" → ")
          : context.entityType === "project"
            ? [entity.organization_name, entity.name].filter(Boolean).join(" → ")
            : entity.name || fallback;
        if (!cancelled && nextLabel) setContextLabel(nextLabel);
      } catch (error) {
        console.error("Unable to verify the current AI context:", error);
        if (!cancelled) setContextLabel("Current context could not be verified");
      }
    }

    loadContextLabel();
    return () => {
      cancelled = true;
    };
  }, [open, context?.entityType, context?.entityId]);


  // ======================================================
  // LOAD GLOBAL CHAT HISTORY
  // ======================================================

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    async function loadHistory() {
      try {
        let data;

        if (activeSessionId) {
          const response =
            await api.chatSessionHistory(activeSessionId);

          data = response.data || {};

          if (
            !data.session ||
            data.session.chatType !== "GLOBAL"
          ) {
            throw new Error("This chat is not a Global AI session.");
          }

          if (!cancelled) {
            setViewingHistory(data.session.status === "ENDED");
            setHistoryStatus(data.session.status || "ENDED");
          }
        } else {
          const response =
            await api.globalChatHistory();

          data = response.data || {};

          if (!cancelled) {
            setViewingHistory(false);
            setHistoryStatus(data.sessionStatus || null);
          }
        }

        const rows = data.messages || [];

        if (!cancelled) {
          setMessages(
            rows.map((row) => ({
              id: row.id,
              role: row.role,
              content: row.content,
              sources: row.sources || [],
            }))
          );
        }
        const proposalResponse = await api.globalActionProposals(data.sessionId || activeSessionId || null);
        if (!cancelled) {
          setActionProposals(proposalResponse.data?.proposals || []);
        }
      } catch (e) {
        if (!cancelled) setError(e.message || "Unable to load chat history.");
        console.error(
          "Failed to load Global AI chat history:",
          e
        );
      } finally {
        if (!cancelled) {
          setHistoryLoaded(true);
        }
      }
    }

    loadHistory();

    return () => {
      cancelled = true;
    };
  }, [open, activeSessionId]);

  async function refreshActionProposals(session = activeSessionId) {
    const response = await api.globalActionProposals(session || null);
    setActionProposals(response.data?.proposals || []);
  }

  async function approveAction(proposal) {
    if (busyProposalIds.includes(proposal.id)) return;
    setBusyProposalIds((ids) => [...ids, proposal.id]);
    setActionProposals((items) => items.map((item) => item.id === proposal.id
      ? { ...item, status: "executing" }
      : item));
    setError("");
    try {
      const response = await api.approveGlobalAction(proposal.id);
      const outcome = response.data || {};
      if (outcome.proposal) {
        setActionProposals((items) => items.map((item) => item.id === proposal.id ? outcome.proposal : item));
      }
      if (outcome.proposal?.status === "succeeded" && outcome.result) {
        if (outcome.result.resourceType === "task" && outcome.result.resource?.id) {
          window.dispatchEvent(new CustomEvent("devflow:ai-action-completed", { detail: outcome.result }));
        }
        setMessages((items) => [...items, {
          role: "assistant",
          content: outcome.replayed
            ? "This action was already completed. Here is the saved result."
            : "The approved action was saved successfully.",
          sources: outcome.result.resource?.id
            ? [{ type: outcome.result.resourceType, id: outcome.result.resource.id, label: outcome.result.resource.name || outcome.result.resource.title }]
            : [],
        }]);
      } else if (outcome.proposal?.status === "failed") {
        setError(outcome.proposal.error || "The action failed. No changes were reported as successful.");
      }
    } catch (e) {
      setError(e.message || "The action outcome could not be confirmed. Check its status before requesting another action.");
      try {
        await refreshActionProposals();
      } catch (refreshError) {
        console.error("Unable to refresh AI action status after approval:", refreshError);
      }
    } finally {
      setBusyProposalIds((ids) => ids.filter((id) => id !== proposal.id));
    }
  }

  async function cancelAction(proposal) {
    if (busyProposalIds.includes(proposal.id)) return;
    setBusyProposalIds((ids) => [...ids, proposal.id]);
    setError("");
    try {
      const response = await api.cancelGlobalAction(proposal.id);
      const updated = response.data?.proposal;
      if (updated) setActionProposals((items) => items.map((item) => item.id === proposal.id ? updated : item));
    } catch (e) {
      setError(e.message || "Unable to cancel this proposal.");
      try {
        await refreshActionProposals();
      } catch (refreshError) {
        console.error("Unable to refresh AI action status after cancellation:", refreshError);
      }
    } finally {
      setBusyProposalIds((ids) => ids.filter((id) => id !== proposal.id));
    }
  }

  async function loadRecentChats() {
    setLoadingHistory(true);
    setError("");
    try {
      const response = await api.recentChats();
      const chats = response.data?.chats || [];
      setRecentChats(chats.filter((chat) => chat.chat_type === "GLOBAL"));
      setHistoryOpen(true);
    } catch (e) {
      setError(e.message || "Unable to load saved conversations.");
    } finally {
      setLoadingHistory(false);
    }
  }

  async function deleteConversation() {
    if (!confirmDeleteChat || deletingChat) return;
    setDeletingChat(true);
    setError("");
    try {
      await api.deleteChatSession(confirmDeleteChat.id);
      setRecentChats((chats) => chats.filter((chat) => String(chat.id) !== String(confirmDeleteChat.id)));
      if (String(activeSessionId) === String(confirmDeleteChat.id)) {
        setSelectedSessionId(null);
        setViewingHistory(false);
        setHistoryStatus(null);
        setHistoryLoaded(false);
      }
      setConfirmDeleteChat(null);
    } catch (e) {
      setError(e.message || "Unable to delete this conversation.");
      setConfirmDeleteChat(null);
    } finally {
      setDeletingChat(false);
    }
  }


  // ======================================================
  // Keep new messages in view unless the reader has scrolled up.
  // ======================================================

  useEffect(() => {
    const body = scrollRef.current;
    if (!body) return;
    if (nearLatestRef.current) {
      body.scrollTop = body.scrollHeight;
      setShowJumpToLatest(false);
    } else if (messages.length > previousMessageCountRef.current || loading) {
      setShowJumpToLatest(true);
    }
    previousMessageCountRef.current = messages.length;
  }, [messages, loading]);

  useEffect(() => {
    if (!actionsOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setActionsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [actionsOpen]);

  function handleMessageScroll() {
    const body = scrollRef.current;
    if (!body) return;
    nearLatestRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 90;
    if (nearLatestRef.current) setShowJumpToLatest(false);
  }

  function jumpToLatest() {
    const body = scrollRef.current;
    if (!body) return;
    body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
    nearLatestRef.current = true;
    setShowJumpToLatest(false);
  }


  // ======================================================
  // SEND MESSAGE
  // ======================================================

  async function sendMessage(text) {
    const trimmed = text.trim();

    if (
      !trimmed ||
      loading ||
      endingChat
    ) {
      return;
    }

    setError("");
    setInput("");
    setLastFailedMessage("");

    setMessages((prev) => [
      ...prev,
      {
        role: "user",
        content: trimmed,
        sources: [],
      },
    ]);

    setLoading(true);

    try {
      const requestId = crypto.randomUUID();
      const response =
        await api.globalChat(trimmed, context, requestId);

      const data = response.data || {};

      const answer = data.answer || "";
      const sources = data.sources || [];
      if (data.actionProposals?.length) {
        setActionProposals((proposals) => {
          const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
          for (const proposal of data.actionProposals) byId.set(proposal.id, proposal);
          return Array.from(byId.values());
        });
      }

      for (const action of data.actionResults || []) {
        window.dispatchEvent(new CustomEvent("devflow:ai-action-completed", {
          detail: action,
        }));
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: answer,
          sources,
          memoriesUsed: data.memoriesUsed || 0,
        },
      ]);
    } catch (e) {
      setLastFailedMessage(trimmed);
      setError(
        e.message ||
          "The AI assistant is unavailable right now."
      );
    } finally {
      setLoading(false);
    }
  }


  // ======================================================
  // END GLOBAL CHAT SESSION
  // ======================================================

  async function handleEndChat() {
    if (viewingHistory) {
      setSelectedSessionId(null);
      setViewingHistory(false);
      setHistoryStatus(null);
      setMessages([]);
      setHistoryLoaded(false);
      return;
    }

    if (
      loading ||
      endingChat
    ) {
      return;
    }

    setConfirmEnd(true);
  }

  async function closeAllChats() {
    if (loading || endingChat || closingAll) return;
    setClosingAll(true);
    setError("");
    try {
      await api.closeAllChats();
      window.dispatchEvent(new Event("devflow:close-all-ai-chats"));
      setConfirmCloseAll(false);
      onClose();
    } catch (e) {
      setError(e.message || "Unable to close all AI chats.");
      setConfirmCloseAll(false);
    } finally {
      setClosingAll(false);
    }
  }

  async function confirmEndChat() {
    setConfirmEnd(false);

    setError("");
    setEndingChat(true);

    try {
      const response = await api.globalChatEnd();
      const result = response.data || {};

      if (!result.ended) {
        setError(result.message || "No active Global AI session found.");
        return;
      }

      setMessages([]);
      setInput("");
      setViewingHistory(false);
      setHistoryStatus(null);
      setHistoryLoaded(false);
      onClose();
    } catch (e) {
      setError(
        e.message ||
          "Unable to end the chat session."
      );
    } finally {
      setEndingChat(false);
    }
  }


  // ======================================================
  // FORM SUBMIT
  // ======================================================

  function handleSubmit(e) {
    e.preventDefault();
    sendMessage(input);
  }


  // ======================================================
  // DO NOT RENDER WHEN CLOSED
  // ======================================================

  if (!open) {
    return null;
  }


  // ======================================================
  // UI
  // ======================================================

  return (
    <div className="ai-global-overlay">

      <section className="ai-global-panel" aria-label="DevFlow AI chat">

        {/* HEADER */}
        <div className="ai-global-header">
          <div className="ai-global-brand">
            <span className="ai-global-brand__icon" aria-hidden="true">✦</span>
            <div className="ai-global-title">
              <h2>DevFlow AI</h2>
              <p className="ai-context-indicator" aria-label="Current AI context" title={contextLabel}>
                {contextLabel}
              </p>
            </div>
          </div>

          <div className="ai-global-header-actions">
            <div className="ai-actions-menu">
              <button
                type="button"
                className="ai-actions-menu__trigger"
                aria-haspopup="true"
                aria-expanded={actionsOpen}
                aria-label="Conversation actions"
                onClick={() => setActionsOpen((isOpen) => !isOpen)}
              >
                <span aria-hidden="true">•••</span>
                <span>Actions</span>
              </button>
              {actionsOpen && (
                <div className="ai-actions-menu__popover" aria-label="Conversation actions">
                  <button
                    type="button"
                    onClick={() => {
                      setActionsOpen(false);
                      if (historyOpen) setHistoryOpen(false);
                      else loadRecentChats();
                    }}
                    disabled={loadingHistory}
                  >
                    {loadingHistory ? "Loading history…" : historyOpen ? "Hide history" : "History"}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActionsOpen(false); setMemoryOpen(true); }}
                  >
                    Memory
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActionsOpen(false); handleEndChat(); }}
                    disabled={loading || endingChat}
                  >
                    {viewingHistory ? "Close history" : endingChat ? "Ending…" : "End chat"}
                  </button>
                  <button
                    type="button"
                    className="ai-actions-menu__danger"
                    onClick={() => { setActionsOpen(false); setConfirmCloseAll(true); }}
                    disabled={loading || endingChat || closingAll}
                  >
                    Close all chats
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="ai-global-close"
              onClick={onClose}
              disabled={endingChat}
              aria-label="Close AI Agent"
              title="Close AI Agent"
            >
              ×
            </button>
          </div>
        </div>


        {viewingHistory && (
          <div className="ai-history-banner">
            Viewing saved chat history
            {historyStatus === "ENDED" ? " · Ended" : ""}
          </div>
        )}

        {historyOpen && (
          <div className="ai-history-list" aria-label="Saved Global AI conversations">
            {!recentChats.length && !loadingHistory && <p>No saved Global AI conversations.</p>}
            {recentChats.map((chat) => (
              <div className="ai-history-item" key={chat.id}>
                <button
                  type="button"
                  className="ai-history-item__open"
                  onClick={() => {
                    setSelectedSessionId(chat.id);
                    setHistoryLoaded(false);
                    setHistoryOpen(false);
                  }}
                >
                  <span>{chat.title || "Untitled conversation"}</span>
                  <small>{chat.status === "ENDED" ? "Ended" : "Active"}</small>
                </button>
                <button
                  type="button"
                  className="ai-history-item__delete"
                  onClick={() => setConfirmDeleteChat(chat)}
                  aria-label={`Delete ${chat.title || "untitled conversation"}`}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}

        {actionProposals.length > 0 && (
          <section className="ai-action-proposals" aria-label="Pending and recent AI actions">
            {actionProposals.map((proposal) => (
              <ActionProposalCard
                key={proposal.id}
                proposal={proposal}
                busy={busyProposalIds.includes(proposal.id)}
                onApprove={approveAction}
                onCancel={cancelAction}
              />
            ))}
          </section>
        )}

        {/* CHAT BODY */}
        <div
          className="ai-global-body"
          ref={scrollRef}
          onScroll={handleMessageScroll}
          aria-label="AI conversation"
        >

          {historyLoaded &&
            messages.length === 0 && (
              <div className="ai-empty-state">
                <strong>How can I help you move work forward?</strong>
                <span>Ask about your authorized workspace, or request a change and review it before anything is updated.</span>
              </div>
            )}


          {messages.map((m, i) => (
            <Message
              key={m.id || i}
              message={m}
            />
          ))}


          {/* THINKING */}
          {loading && (
            <div className="ai-message ai-message-assistant">
              <div className="ai-message-bubble ai-thinking">
                Thinking&hellip;
              </div>
            </div>
          )}

        </div>

        {showJumpToLatest && (
          <button type="button" className="ai-jump-latest" onClick={jumpToLatest}>
            Jump to latest
          </button>
        )}

        {/* ERROR */}
        {error && (
          <div className="ai-error">
            {error}
            {lastFailedMessage && (
              <button type="button" onClick={() => sendMessage(lastFailedMessage)} disabled={loading}>
                Retry
              </button>
            )}
          </div>
        )}


        {/* SUGGESTIONS */}
        {messages.length === 0 && !viewingHistory && (
          <div className="ai-suggestions">

            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="ai-suggestion-chip"
                onClick={() =>
                  sendMessage(s)
                }
                disabled={
                  loading ||
                  endingChat
                }
              >
                {s}
              </button>
            ))}

          </div>
        )}


        {/* INPUT */}
        <form
          className="ai-input-row"
          aria-label="AI message composer"
          onSubmit={handleSubmit}
        >
          <div className="ai-composer">
            <div className="ai-composer-meta">
              <span className="ai-composer-context" title={contextLabel}>
                <span aria-hidden="true">◈</span>
                <span>{contextLabel}</span>
              </span>
              <span className="ai-composer-shortcut">Enter to send · Shift+Enter for new line</span>
            </div>
            <div className="ai-composer-controls">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage(input);
                  }
                }}
                placeholder="Message DevFlow AI…"
                aria-label="Message DevFlow AI"
                rows={2}
                disabled={loading || endingChat || viewingHistory}
              />
              <button
                type="submit"
                className="btn btn-primary ai-send-btn"
                disabled={loading || endingChat || viewingHistory || !input.trim()}
              >
                {loading ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </form>

      </section>

      <ConfirmDialog
        isOpen={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        onConfirm={confirmEndChat}
        busy={endingChat}
        title="End chat session"
        description="End this AI chat session? You can still review saved history, but this conversation can't be continued."
        confirmLabel="End session"
      />
      <ConfirmDialog
        isOpen={confirmCloseAll}
        onClose={() => !closingAll && setConfirmCloseAll(false)}
        onConfirm={closeAllChats}
        busy={closingAll}
        title="Close all AI chats"
        description="End all of your active AI chat sessions? Saved conversation history and AI memories will be preserved."
        confirmLabel="Close all chats"
      />
      <ConfirmDialog
        isOpen={Boolean(confirmDeleteChat)}
        onClose={() => !deletingChat && setConfirmDeleteChat(null)}
        onConfirm={deleteConversation}
        busy={deletingChat}
        title="Delete conversation"
        description="Delete this conversation and its messages? Saved AI memory is stored separately and will not be deleted."
        confirmLabel="Delete conversation"
      />
      <AIMemoryPanel isOpen={memoryOpen} onClose={() => setMemoryOpen(false)} />

    </div>
  );
}
